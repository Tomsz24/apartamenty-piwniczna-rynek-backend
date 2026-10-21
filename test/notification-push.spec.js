const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');

const {
  notificationPreferenceFor,
  buildApnsPayload,
  classifyApnsResponse,
  latestIncomingMessage,
  notificationRetryDelaySeconds,
} = require('../dist/notifications/notification.domain');
const { ApnsClient } = require('../dist/notifications/apns.client');
const { NotificationDispatchService } = require('../dist/notifications/notification-dispatch.service');
const { NotificationProducerService } = require('../dist/notifications/notification-producer.service');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const TOKEN_C = 'c'.repeat(64);

function config(values) {
  return { get: (key) => values[key] };
}

test('event types map to the admin preference that gates them', () => {
  assert.equal(notificationPreferenceFor('new_reservation'), 'new_reservations');
  assert.equal(notificationPreferenceFor('new_message'), 'new_messages');
  assert.equal(notificationPreferenceFor('reservation_modified'), 'reservation_updates');
  assert.equal(notificationPreferenceFor('reservation_cancelled'), 'cancellations');
  assert.equal(notificationPreferenceFor('access_code_error'), 'access_code_errors');
  assert.equal(notificationPreferenceFor('access_code_missing'), 'access_code_errors');
  assert.equal(notificationPreferenceFor('arrival_message_reminder'), 'arrival_message_reminder');
  assert.equal(notificationPreferenceFor('system_alert'), null);
  assert.deepEqual([1, 2, 3, 10].map(notificationRetryDelaySeconds), [30, 60, 120, 3600]);
});

test('APNs payload carries deep-link ids only and truncates long text', () => {
  const payload = buildApnsPayload({
    id: 'event-1',
    eventType: 'new_message',
    title: 'Nowa wiadomość',
    body: 'x'.repeat(500),
    payload: { conversationId: 'conv-1', reservationId: 'res-1', secret: 'drop', accessCodeId: 7 },
    badge: 3.7,
  });
  assert.equal(payload.aps.alert.body.length, 240);
  assert.equal(payload.aps.badge, 3);
  assert.equal(payload.aps['thread-id'], 'new_message');
  assert.equal(payload.conversationId, 'conv-1');
  assert.equal(payload.reservationId, 'res-1');
  assert.equal('secret' in payload, false);
  assert.equal('accessCodeId' in payload, false);
});

test('APNs responses are classified into sent, retry, invalid token and rejected', () => {
  assert.equal(classifyApnsResponse(200, null), 'sent');
  assert.equal(classifyApnsResponse(410, 'Unregistered'), 'invalid_token');
  assert.equal(classifyApnsResponse(400, 'BadDeviceToken'), 'invalid_token');
  assert.equal(classifyApnsResponse(400, 'DeviceTokenNotForTopic'), 'invalid_token');
  assert.equal(classifyApnsResponse(429, 'TooManyRequests'), 'retry');
  assert.equal(classifyApnsResponse(503, null), 'retry');
  assert.equal(classifyApnsResponse(403, 'ExpiredProviderToken'), 'retry');
  assert.equal(classifyApnsResponse(403, 'InvalidProviderToken'), 'rejected');
  assert.equal(classifyApnsResponse(400, 'PayloadTooLarge'), 'rejected');
});

test('only the newest guest message produces a notification', () => {
  const base = { id: 'conv-1', guestName: 'Anna Kowalska' };
  assert.equal(latestIncomingMessage({ ...base, messages: [] }), null);
  assert.equal(latestIncomingMessage({ ...base, messages: [
    { id: 'm1', text: 'Dzień dobry', isOutgoing: false, sentAt: '2026-10-20T10:00:00Z', attachments: [] },
    { id: 'm2', text: 'Witamy', isOutgoing: true, sentAt: '2026-10-20T10:05:00Z', attachments: [] },
  ] }), null);

  assert.deepEqual(latestIncomingMessage({ ...base, messages: [
    { id: 'm3', text: 'Później', isOutgoing: false, sentAt: '2026-10-20T11:00:00Z', attachments: [] },
    { id: 'm2', text: 'Witamy', isOutgoing: true, sentAt: '2026-10-20T10:05:00Z', attachments: [] },
  ] }), { messageId: 'm3', title: 'Nowa wiadomość — Anna Kowalska', body: 'Później' });

  const attachment = latestIncomingMessage({ id: 'conv-2', guestName: null, messages: [
    { id: '', text: '  ', isOutgoing: false, sentAt: null, attachments: ['https://example.test/a.jpg'] },
  ] });
  assert.equal(attachment.title, 'Nowa wiadomość');
  assert.equal(attachment.body, 'Załącznik');
  assert.equal(attachment.messageId, 'conv-2:1');
});

test('APNs client stays disabled without credentials and validates tokens before connecting', async () => {
  const client = new ApnsClient(config({}));
  assert.equal(client.isConfigured(), false);
  assert.equal(client.getStatus().bundleId, 'Tomsz24.apartamenty-piwniczna-rynek');
  assert.deepEqual(await client.send('production', 'not-a-token', {}), {
    status: 400, reason: 'BadDeviceToken', apnsId: null,
  });
});

test('APNs provider token is an ES256 JWT signed with the .p8 key and cached', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const client = new ApnsClient(config({
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
  }));
  assert.equal(client.isConfigured(), true);
  const token = await client.providerToken();
  assert.equal(await client.providerToken(), token);

  const { jwtVerify, decodeProtectedHeader } = require('jose');
  const { payload } = await jwtVerify(token, publicKey);
  assert.equal(payload.iss, 'TEAM123456');
  assert.equal(typeof payload.iat, 'number');
  assert.deepEqual(decodeProtectedHeader(token), { alg: 'ES256', kid: 'KEY1234567' });
});

// In-memory stand-in for the queries NotificationDispatchService issues.
function createDispatchPool({ events, devices, preferences = {} }) {
  const deliveries = [];
  const pool = {
    events, devices, deliveries,
    query: async (text, params = []) => {
      if (text.includes("WHERE status = 'processing' AND updated_at")) return { rows: [] };
      if (text.includes("status = 'processing', attempt_count = attempt_count + 1")) {
        const claimed = events.filter((event) => event.status === 'pending' && event.scheduled_for <= Date.now());
        for (const event of claimed) {
          event.status = 'processing';
          event.attempt_count += 1;
        }
        return { rows: claimed.map((event) => ({ ...event })) };
      }
      if (text.includes('FROM notification_devices AS device')) {
        const event = events.find((candidate) => candidate.id === params[0]);
        const match = text.match(/COALESCE\(preference\.(\w+), true\)/);
        return {
          rows: devices.filter((device) => device.enabled).map((device) => ({
            device_id: device.id,
            device_token: device.token,
            environment: device.environment,
            admin_user_id: device.admin,
            admin_email: `${device.admin}@example.test`,
            allowed: match ? preferences[device.admin]?.[match[1]] ?? true : true,
            delivery_status: deliveries.find((delivery) =>
              delivery.event === event.id && delivery.device === device.id)?.status ?? null,
          })),
        };
      }
      if (text.includes('FROM notification_events AS event')) return { rows: [{ count: '4' }] };
      if (text.includes('INSERT INTO notification_deliveries')) {
        let delivery = deliveries.find((candidate) => candidate.event === params[0] && candidate.device === params[1]);
        if (!delivery) {
          delivery = { id: `delivery-${deliveries.length + 1}`, event: params[0], device: params[1], attempts: 0 };
          deliveries.push(delivery);
        }
        delivery.attempts += 1;
        delivery.status = 'processing';
        return { rows: [{ id: delivery.id }] };
      }
      if (text.includes('UPDATE notification_deliveries')) {
        const delivery = deliveries.find((candidate) => candidate.id === params[0]);
        Object.assign(delivery, { status: params[1], apnsId: params[2], error: params[3] });
        return { rows: [] };
      }
      if (text.includes('enabled = false, disabled_at')) {
        devices.find((device) => device.id === params[0]).enabled = false;
        return { rows: [] };
      }
      if (text.includes('UPDATE notification_devices')) return { rows: [] };
      if (text.includes('scheduled_for = NOW() + make_interval')) {
        const event = events.find((candidate) => candidate.id === params[0]);
        Object.assign(event, { status: 'pending', last_error: params[1], scheduled_for: Date.now() + params[2] * 1000 });
        return { rows: [] };
      }
      if (text.includes('sent_at = CASE WHEN $2')) {
        const event = events.find((candidate) => candidate.id === params[0]);
        Object.assign(event, { status: params[1], last_error: params[2] });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  return pool;
}

function event(overrides = {}) {
  return {
    id: 'event-1', event_type: 'new_reservation', title: 'Nowa rezerwacja', body: 'Góry · Anna',
    payload: { reservationId: 'res-1' }, attempt_count: 0, status: 'pending',
    scheduled_for: 0, created_at: new Date(), ...overrides,
  };
}

function fakeApns(responses) {
  const sent = [];
  return {
    sent,
    isConfigured: () => true,
    getStatus: () => ({ configured: true }),
    send: async (environment, token, payload) => {
      sent.push({ environment, token, payload });
      const response = responses[token] ?? { status: 200, reason: null, apnsId: `apns-${token[0]}` };
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function dispatcher(pool, apns, enabled = 'true') {
  return new NotificationDispatchService(pool, apns, config({ NOTIFICATIONS_ENABLED: enabled }));
}

test('dispatcher respects preferences, disables dead tokens and marks the event sent', async () => {
  const pool = createDispatchPool({
    events: [event()],
    devices: [
      { id: 'd1', token: TOKEN_A, environment: 'production', admin: 'owner', enabled: true },
      { id: 'd2', token: TOKEN_B, environment: 'sandbox', admin: 'partner', enabled: true },
      { id: 'd3', token: TOKEN_C, environment: 'production', admin: 'owner', enabled: true },
    ],
    preferences: { partner: { new_reservations: false } },
  });
  const apns = fakeApns({ [TOKEN_C]: { status: 410, reason: 'Unregistered', apnsId: null } });
  await dispatcher(pool, apns).dispatch();

  assert.deepEqual(apns.sent.map((item) => item.token), [TOKEN_A, TOKEN_C]);
  assert.equal(apns.sent[0].payload.aps.badge, 4);
  assert.equal(apns.sent[0].payload.reservationId, 'res-1');
  assert.deepEqual(pool.deliveries.map((delivery) => delivery.status), ['sent', 'skipped', 'skipped']);
  assert.equal(pool.devices[2].enabled, false);
  assert.equal(pool.events[0].status, 'sent');
});

test('transient APNs failures are retried without re-sending to devices that already got it', async () => {
  const pool = createDispatchPool({
    events: [event()],
    devices: [
      { id: 'd1', token: TOKEN_A, environment: 'production', admin: 'owner', enabled: true },
      { id: 'd2', token: TOKEN_B, environment: 'production', admin: 'owner', enabled: true },
    ],
  });
  const responses = { [TOKEN_B]: { status: 503, reason: 'ServiceUnavailable', apnsId: null } };
  const apns = fakeApns(responses);
  const service = dispatcher(pool, apns);
  await service.dispatch();
  assert.equal(pool.events[0].status, 'pending');
  assert.ok(pool.events[0].scheduled_for > Date.now());
  assert.equal(pool.events[0].last_error, 'APNs 503 ServiceUnavailable');

  delete responses[TOKEN_B];
  pool.events[0].scheduled_for = 0;
  await service.dispatch();
  assert.deepEqual(apns.sent.map((item) => item.token), [TOKEN_A, TOKEN_B, TOKEN_B]);
  assert.equal(pool.events[0].status, 'sent');
});

test('events give up after five attempts and stale events are never pushed', async () => {
  const pool = createDispatchPool({
    events: [
      event({ id: 'retry', attempt_count: 4 }),
      event({ id: 'old', created_at: new Date(Date.now() - 13 * 60 * 60 * 1000) }),
    ],
    devices: [{ id: 'd1', token: TOKEN_A, environment: 'production', admin: 'owner', enabled: true }],
  });
  const apns = fakeApns({ [TOKEN_A]: new Error('socket hang up') });
  await dispatcher(pool, apns).dispatch();
  assert.equal(pool.events[0].status, 'failed');
  assert.equal(pool.events[0].last_error, 'socket hang up');
  assert.equal(pool.events[1].status, 'failed');
  assert.match(pool.events[1].last_error, /wygasło/);
  assert.equal(apns.sent.length, 1);
});

test('dispatcher does nothing while disabled or without APNs credentials', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  await dispatcher(pool, fakeApns({}), 'false').dispatch();
  await dispatcher(pool, { ...fakeApns({}), isConfigured: () => false }).dispatch();
});

test('producer stores a message event linked to the reservation and skips our own replies', async () => {
  const queries = [];
  const pool = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM reservations')) return { rows: [{ id: 'res-1', apartment_id: 'apt-1' }] };
      return { rowCount: 1, rows: [] };
    },
  };
  const producer = new NotificationProducerService(pool, config({}));
  assert.equal(await producer.enqueueHostexMessage({ id: 'conv-1', guestName: 'Anna', messages: [
    { id: 'm1', text: 'Witamy', isOutgoing: true, sentAt: null, attachments: [] },
  ] }), false);
  assert.equal(queries.length, 0);

  assert.equal(await producer.enqueueHostexMessage({ id: 'conv-1', guestName: 'Anna', messages: [
    { id: 'm2', text: 'O której zameldowanie?', isOutgoing: false, sentAt: null, attachments: [] },
  ] }), true);
  const insert = queries[1];
  assert.match(insert.text, /'new_message'/);
  assert.deepEqual(insert.params.slice(0, 5), [
    'new_message:conv-1:m2', 'apt-1', 'res-1', 'Nowa wiadomość — Anna', 'O której zameldowanie?',
  ]);
  assert.deepEqual(JSON.parse(insert.params[5]), { conversationId: 'conv-1', reservationId: 'res-1' });
});

test('scheduled producers stay off unless notifications are enabled', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  await new NotificationProducerService(pool, config({})).handleScheduledChecks();
});

// Optional real PostgreSQL engine test: set PGLITE_MODULE to an installed @electric-sql/pglite.
test('database triggers and scheduled producers create the right notification events', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite({ timezone: 'UTC' });
  const migration = (name) => readFileSync(join(__dirname, '../migrations', name), 'utf8');
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE apartments(
        id uuid PRIMARY KEY, name text,
        access_code_time_zone text NOT NULL DEFAULT 'Europe/Warsaw',
        access_code_check_in_time time NOT NULL DEFAULT '12:00');
      CREATE TABLE reservations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), apartment_id uuid, origin text, status text,
        start_date date, end_date date, guest_name text, guest_count integer, note text,
        last_seen_at timestamptz, arrival_message_sent_at timestamptz,
        metadata jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE reservation_review_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE apartment_access_devices(
        apartment_id uuid, provider text, scope text, active boolean);
      CREATE TABLE reservation_access_codes(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reservation_id uuid, apartment_id uuid,
        status text, updated_at timestamptz NOT NULL DEFAULT NOW());
      INSERT INTO apartments(id, name) VALUES
        ('00000000-0000-0000-0000-000000000001', 'Góry'),
        ('00000000-0000-0000-0000-000000000002', 'Rynek');
      INSERT INTO apartment_access_devices VALUES
        ('00000000-0000-0000-0000-000000000001', 'ttlock', 'apartment', true);`);
    await db.exec(migration('004_notification_infrastructure.sql'));
    await db.exec(migration('014_notification_inbox_reads.sql'));
    await db.exec(migration('20261021160000_hostex_webhook_events.sql'));
    await db.exec(migration('20261021180000_notification_event_producers.sql'));
    await db.exec(migration('20261021180000_notification_event_producers.sql'));

    const events = async () => (await db.query(
      'SELECT event_type, priority, title, body FROM notification_events ORDER BY created_at, event_type',
    )).rows;
    const insert = async (values) => (await db.query(
      `INSERT INTO reservations(apartment_id, origin, status, start_date, end_date, guest_name)
       VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'Europe/Warsaw')::date + $4::int,
               (NOW() AT TIME ZONE 'Europe/Warsaw')::date + $5::int, $6) RETURNING id`,
      values,
    )).rows[0].id;

    const id = await insert(['00000000-0000-0000-0000-000000000002', 'hostex', 'confirmed', 10, 13, 'Anna']);
    await insert(['00000000-0000-0000-0000-000000000002', 'hostex', 'confirmed', -10, -7, 'Past']);
    await insert(['00000000-0000-0000-0000-000000000002', 'manual', 'blocked', 20, 22, null]);
    await insert(['00000000-0000-0000-0000-000000000002', 'booking_ical', 'confirmed', 30, 32, null]);
    let rows = await events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'new_reservation');
    assert.match(rows[0].body, /^Rynek · Anna · \d\d\.\d\d–\d\d\.\d\d\.\d{4}$/);

    await db.query(`UPDATE reservations SET last_seen_at = NOW(), metadata = '{"sync":1}' WHERE id = $1`, [id]);
    await db.query(`UPDATE reservations SET guest_count = 3 WHERE id = $1`, [id]);
    await db.query(`UPDATE reservations SET guest_count = 3, last_seen_at = NOW() WHERE id = $1`, [id]);
    await db.query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [id]);
    await db.query(`UPDATE reservations SET status = 'cancelled', note = 'x' WHERE id = $1`, [id]);
    rows = await events();
    assert.deepEqual(rows.map((row) => row.event_type),
      ['new_reservation', 'reservation_modified', 'reservation_cancelled']);
    assert.equal(rows[2].priority, 'high');

    // Arrival today: reminder and missing access code (Góry has a TTLock device, Rynek does not).
    const today = await insert(['00000000-0000-0000-0000-000000000001', 'hostex', 'confirmed', 0, 2, 'Jan']);
    await insert(['00000000-0000-0000-0000-000000000002', 'hostex', 'confirmed', 0, 2, 'Ola']);
    const pool = { query: async (text, params) => {
      const result = await db.query(text, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    } };
    const producer = new NotificationProducerService(pool, config({
      NOTIFICATION_ARRIVAL_REMINDER_TIME: '00:00',
      NOTIFICATION_MISSING_CODE_LEAD_MINUTES: '720',
    }));
    // 00:00 reminder is always due today; the code check uses check-in 12:00 minus 12 h.
    assert.equal(await producer.enqueueArrivalReminders(), 2);
    assert.equal(await producer.enqueueArrivalReminders(), 0);
    assert.equal(await producer.enqueueMissingAccessCodes(), 1);
    assert.equal(await producer.enqueueMissingAccessCodes(), 0);

    const code = (await db.query(
      `INSERT INTO reservation_access_codes(reservation_id, apartment_id, status)
       VALUES ($1, '00000000-0000-0000-0000-000000000001', 'active') RETURNING id`, [today],
    )).rows[0].id;
    await db.query(`UPDATE reservation_access_codes SET status = 'sync_error', updated_at = NOW() WHERE id = $1`, [code]);
    await db.query(`UPDATE reservation_access_codes SET status = 'sync_error' WHERE id = $1`, [code]);
    const errors = (await db.query(
      `SELECT priority, title FROM notification_events WHERE event_type = 'access_code_error'`,
    )).rows;
    assert.deepEqual(errors, [{ priority: 'critical', title: 'Błąd kodu do drzwi' }]);

    // A broken notification insert must never block the reservation write itself.
    await db.exec(`ALTER TABLE notification_events ADD CONSTRAINT block_all CHECK (false) NOT VALID`);
    await insert(['00000000-0000-0000-0000-000000000002', 'hostex', 'confirmed', 40, 42, 'Ewa']);
    assert.equal((await db.query(`SELECT count(*)::int n FROM reservations WHERE guest_name = 'Ewa'`)).rows[0].n, 1);
  } finally {
    await db.close();
  }
});
