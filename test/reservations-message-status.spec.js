const test = require('node:test');
const assert = require('node:assert/strict');
const { ReservationsService } = require('../dist/reservations/reservations.service');

function buildService({ existing, returned }) {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      statements.push({ sql: normalized, values });
      if (normalized === 'SELECT * FROM reservations WHERE id = $1 FOR UPDATE') {
        return { rows: [existing] };
      }
      if (normalized === 'SELECT 1 FROM apartments WHERE id = $1') return { rows: [{ '?column?': 1 }] };
      if (normalized.startsWith('SELECT id FROM reservations WHERE apartment_id = $1')) return { rows: [] };
      if (normalized.startsWith('SELECT r.*, a.name AS apartment_name')) return { rows: [returned] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    service: new ReservationsService({ connect: async () => client }),
    statements,
  };
}

function reservationRow(overrides = {}) {
  return {
    id: '0c8f6957-25cb-414b-9c90-b294f6ab4b4c',
    apartment_id: '18be1828-9fc4-40ca-90d9-3e48fc86f76a',
    apartment_name: 'Apartament Rynek',
    origin: 'hostex',
    status: 'confirmed',
    start_date: '2026-11-02',
    end_date: '2026-11-05',
    guest_name: 'Gość',
    guest_count: 2,
    adults: 2,
    children: 0,
    child_ages: null,
    version: 2,
    created_by: 'system',
    created_at: new Date('2026-10-01T10:00:00.000Z'),
    updated_at: new Date('2026-10-20T10:00:00.000Z'),
    metadata: {},
    ...overrides,
  };
}

test('arrival message sent timestamp is persisted and returned by reservation update', async () => {
  const timestamp = '2026-10-20T14:15:30.000Z';
  const { service, statements } = buildService({
    existing: reservationRow({ version: 1 }),
    returned: reservationRow({ arrival_message_sent_at: new Date(timestamp) }),
  });

  const result = await service.update(
    '0c8f6957-25cb-414b-9c90-b294f6ab4b4c',
    { arrivalMessageSentAt: timestamp, expectedVersion: 1 },
    'admin@example.com',
  );

  const update = statements.find(({ sql }) => sql.startsWith('UPDATE reservations SET arrival_message_sent_at'));
  assert.ok(update);
  assert.equal(update.values[0], timestamp);
  assert.equal(result.arrivalMessageSentAt, timestamp);
});

test('message sent timestamp can be cleared to undo a manual confirmation', async () => {
  const { service, statements } = buildService({
    existing: reservationRow({ version: 1 }),
    returned: reservationRow(),
  });

  const result = await service.update(
    '0c8f6957-25cb-414b-9c90-b294f6ab4b4c',
    { arrivalMessageSentAt: null, expectedVersion: 1 },
    'admin@example.com',
  );

  const update = statements.find(({ sql }) => sql.startsWith('UPDATE reservations SET arrival_message_sent_at'));
  assert.ok(update);
  assert.equal(update.values[0], null);
  assert.equal(result.arrivalMessageSentAt, null);
});
