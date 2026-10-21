const test = require('node:test');
const assert = require('node:assert/strict');
const { NotificationsService } = require('../dist/notifications/notifications.service');

const admin = { id: '4a0d5ee7-487a-4b28-9803-713585e70249', email: 'admin@example.com' };

test('registers an APNs device for the authenticated administrator and re-enables an old token', async () => {
  let call;
  const service = new NotificationsService({
    query: async (sql, values) => {
      call = { sql, values };
      return { rows: [{ id: 'device-1', enabled: true }] };
    },
  });

  const result = await service.registerDevice(admin, {
    deviceToken: 'A'.repeat(64),
    environment: 'sandbox',
    appId: 'com.example.app',
  });

  assert.deepEqual(result, { registered: true, deviceId: 'device-1' });
  assert.match(call.sql, /ON CONFLICT \(push_provider, environment, device_token\) DO UPDATE/);
  assert.match(call.sql, /enabled = true/);
  assert.deepEqual(call.values, [admin.id, admin.email, 'sandbox', 'a'.repeat(64), 'com.example.app']);
});

test('returns safe default notification preferences before an administrator changes them', async () => {
  const service = new NotificationsService({ query: async () => ({ rows: [] }) });
  assert.deepEqual(await service.getPreferences(admin), {
    newReservations: true,
    newMessages: true,
    reservationUpdates: true,
    cancellations: true,
    accessCodeErrors: true,
    arrivalMessageReminder: true,
  });
});

test('stores all notification preferences against the verified administrator identity', async () => {
  let call;
  const preferences = {
    newReservations: true,
    newMessages: false,
    reservationUpdates: true,
    cancellations: false,
    accessCodeErrors: true,
    arrivalMessageReminder: false,
  };
  const service = new NotificationsService({
    query: async (sql, values) => {
      call = { sql, values };
      return { rows: [preferences] };
    },
  });

  assert.deepEqual(await service.updatePreferences(admin, preferences), preferences);
  assert.match(call.sql, /ON CONFLICT \(admin_user_id\) DO UPDATE/);
  assert.deepEqual(call.values, [admin.id, admin.email, true, false, true, false, true, false]);
});

test('loads an authenticated administrator inbox and unread count', async () => {
  const calls = [];
  const service = new NotificationsService({
    query: async (sql, values) => {
      calls.push({ sql, values });
      return calls.length === 1
        ? { rows: [{ id: 'n-1', title: 'Nowa rezerwacja', readAt: null }] }
        : { rows: [{ count: '1' }] };
    },
  });

  assert.deepEqual(await service.getInbox(admin), {
    items: [{ id: 'n-1', title: 'Nowa rezerwacja', readAt: null }],
    unreadCount: 1,
  });
  assert.match(calls[0].sql, /notification_event_reads reads/);
  assert.match(calls[0].sql, /ORDER BY e\.created_at DESC/);
  assert.deepEqual(calls.map((call) => call.values), [[admin.id], [admin.id]]);
});

test('marks only the selected notification read for the authenticated administrator', async () => {
  let call;
  const service = new NotificationsService({
    query: async (sql, values) => {
      call = { sql, values };
      return { rows: [{ notification_event_id: 'event-1' }], rowCount: 1 };
    },
  });

  assert.deepEqual(await service.markInboxItemRead(admin, 'event-1'), { read: true });
  assert.match(call.sql, /ON CONFLICT \(notification_event_id, admin_user_id\) DO UPDATE/);
  assert.deepEqual(call.values, ['event-1', admin.id]);
});

test('marks all non-cancelled inbox events read without overwriting existing read times', async () => {
  let call;
  const service = new NotificationsService({
    query: async (sql, values) => {
      call = { sql, values };
      return { rows: [], rowCount: 3 };
    },
  });

  assert.deepEqual(await service.markAllInboxRead(admin), { markedRead: 3 });
  assert.match(call.sql, /status <> 'cancelled'/);
  assert.match(call.sql, /ON CONFLICT \(notification_event_id, admin_user_id\) DO NOTHING/);
  assert.deepEqual(call.values, [admin.id]);
});
