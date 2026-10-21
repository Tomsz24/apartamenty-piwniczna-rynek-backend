const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');

const {
  parseHostexWebhook,
  verifyHostexWebhookSecret,
  hostexWebhookAction,
  hostexWebhookRetryDelayMinutes,
} = require('../dist/hostex/hostex-webhook.domain');
const { HostexWebhookService } = require('../dist/hostex/hostex-webhook.service');
const { HostexWebhookController } = require('../dist/hostex/hostex-webhook.controller');

const SECRET = 'whsec-test-value';

function config(values) {
  return { get: (key) => values[key] };
}

// Minimal in-memory stand-in for the hostex_webhook_events queries the service issues.
function createInboxPool() {
  const rows = [];
  const pool = {
    rows,
    query: async (text, params = []) => {
      if (text.startsWith('INSERT INTO hostex_webhook_events')) {
        if (rows.some((row) => row.dedupe_key === params[0])) return { rowCount: 0, rows: [] };
        const row = {
          id: `event-${rows.length + 1}`, dedupe_key: params[0], event_id: params[1],
          event_type: params[2], reservation_code: params[3], conversation_id: params[6],
          status: 'pending', attempts: 0,
          last_error: null, next_attempt_at: 0, received_at: new Date(),
        };
        rows.push(row);
        return { rowCount: 1, rows: [{ id: row.id }] };
      }
      if (text.trim().startsWith('UPDATE hostex_webhook_events SET\n         attempts')) {
        const row = rows.find((candidate) =>
          candidate.status === 'pending' && candidate.next_attempt_at <= Date.now());
        if (!row) return { rowCount: 0, rows: [] };
        row.attempts += 1;
        row.next_attempt_at = Date.now() + 10 * 60_000;
        return { rowCount: 1, rows: [{ ...row }] };
      }
      if (text.includes('processed_at = NOW()')) {
        const row = rows.find((candidate) => candidate.id === params[0]);
        Object.assign(row, { status: params[1], last_error: null });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('make_interval')) {
        const row = rows.find((candidate) => candidate.id === params[0]);
        Object.assign(row, {
          status: params[1], last_error: params[2],
          next_attempt_at: Date.now() + params[3] * 60_000,
        });
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
  return pool;
}

function createService({ pool = createInboxPool(), sync, secret = SECRET, conversation, messages = [] } = {}) {
  const calls = [];
  const hostexService = {
    getConversation: async (id) => conversation ?? { id, guestName: 'Anna', messages: [] },
  };
  const producer = {
    enqueueHostexMessage: async (value) => {
      messages.push(value);
      return true;
    },
  };
  const syncService = {
    syncReservations: sync ?? (async (apply, filter) => {
      calls.push({ apply, filter });
      return { fetched: 1 };
    }),
  };
  const service = new HostexWebhookService(
    pool, syncService, hostexService, producer, config({ HOSTEX_WEBHOOK_SECRET: secret }),
  );
  return { service, pool, calls, messages };
}

test('webhook secret check accepts only the exact configured token', () => {
  assert.equal(verifyHostexWebhookSecret(SECRET, SECRET), true);
  assert.equal(verifyHostexWebhookSecret(SECRET, `${SECRET}x`), false);
  assert.equal(verifyHostexWebhookSecret(SECRET, ''), false);
  assert.equal(verifyHostexWebhookSecret(SECRET, undefined), false);
  assert.equal(verifyHostexWebhookSecret(SECRET, ['array']), false);
  assert.equal(verifyHostexWebhookSecret('', ''), false);
});

test('parses identifiers from top-level or nested payloads and keeps no guest data', () => {
  const parsed = parseHostexWebhook({
    event: 'reservation_updated',
    event_id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    timestamp: '2026-10-21T10:00:00Z',
    data: { reservation_code: '0-1234-abc', stay_code: 'stay-9', property_id: 12761007, guest_name: 'Anna' },
  });
  assert.deepEqual(parsed, {
    dedupeKey: 'event:01JABCDEFGHJKMNPQRSTVWXYZ0',
    eventId: '01JABCDEFGHJKMNPQRSTVWXYZ0',
    eventType: 'reservation_updated',
    reservationCode: '0-1234-abc',
    stayCode: 'stay-9',
    propertyId: 12761007,
    conversationId: null,
    payloadKeys: ['data', 'event', 'event_id', 'timestamp'],
  });
  assert.equal(JSON.stringify(parsed).includes('Anna'), false);

  const topLevel = parseHostexWebhook({ event: 'reservation_created', reservation_code: 'R-1' });
  assert.equal(topLevel.reservationCode, 'R-1');
  assert.match(topLevel.dedupeKey, /^body:[0-9a-f]{64}$/);
});

test('rejects payloads without a usable event type and drops unsafe identifiers', () => {
  assert.equal(parseHostexWebhook(null), null);
  assert.equal(parseHostexWebhook([]), null);
  assert.equal(parseHostexWebhook({}), null);
  assert.equal(parseHostexWebhook({ event: 'DROP TABLE; --' }), null);
  const parsed = parseHostexWebhook({ event: 'reservation_created', reservation_code: '../etc/passwd', property_id: -3 });
  assert.equal(parsed.reservationCode, null);
  assert.equal(parsed.propertyId, null);
});

test('body-hash dedupe key ignores key order when Hostex sends no event_id', () => {
  const a = parseHostexWebhook({ event: 'reservation_created', data: { a: 1, b: 2 } });
  const b = parseHostexWebhook({ data: { b: 2, a: 1 }, event: 'reservation_created' });
  const c = parseHostexWebhook({ event: 'reservation_created', data: { a: 1, b: 3 } });
  assert.equal(a.dedupeKey, b.dedupeKey);
  assert.notEqual(a.dedupeKey, c.dedupeKey);
});

test('maps event types to actions and backs off retries', () => {
  assert.equal(hostexWebhookAction('reservation_created'), 'sync_reservation');
  assert.equal(hostexWebhookAction('reservation_updated'), 'sync_reservation');
  assert.equal(hostexWebhookAction('authorization_revoked'), 'authorization_revoked');
  assert.equal(hostexWebhookAction('message_created'), 'new_message');
  assert.equal(hostexWebhookAction('review_created'), 'ignore');
  assert.equal(hostexWebhookAction('something_new'), 'ignore');
  assert.deepEqual([1, 2, 3, 4, 10].map(hostexWebhookRetryDelayMinutes), [1, 2, 4, 8, 60]);
});

test('duplicate deliveries are stored once and processed once', async () => {
  const { service, pool, calls } = createService();
  const event = parseHostexWebhook({ event: 'reservation_created', event_id: 'EVT1', reservation_code: 'R-1' });

  assert.deepEqual(await service.receive(event), { duplicate: false });
  assert.deepEqual(await service.receive(event), { duplicate: true });
  await service.processPending();

  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].status, 'processed');
  assert.deepEqual(calls, [{ apply: true, filter: { reservationCode: 'R-1' } }]);
});

test('reservation events fall back to a full sync when the code is missing or unknown', async () => {
  const calls = [];
  const { service } = createService({
    sync: async (apply, filter) => {
      calls.push(filter ?? null);
      return { fetched: filter?.reservationCode ? 0 : 5 };
    },
  });
  await service.receive(parseHostexWebhook({ event: 'reservation_updated', event_id: 'A', reservation_code: 'GONE' }));
  await service.receive(parseHostexWebhook({ event: 'reservation_created', event_id: 'B' }));
  await service.processPending();
  assert.deepEqual(calls, [{ reservationCode: 'GONE' }, null, null]);
});

test('message webhooks read the conversation and hand it to the notification producer', async () => {
  const conversation = { id: 'conv-7', guestName: 'Anna', messages: [] };
  const { service, pool, messages, calls } = createService({ conversation });
  await service.receive(parseHostexWebhook({
    event: 'message_created', event_id: 'MSG1', data: { conversation_id: 'conv-7', content: 'Hej' },
  }));
  await service.processPending();
  assert.equal(pool.rows[0].conversation_id, 'conv-7');
  assert.equal(pool.rows[0].status, 'processed');
  assert.deepEqual(messages, [conversation]);
  assert.equal(calls.length, 0);

  const withoutConversation = createService();
  await withoutConversation.service.receive(parseHostexWebhook({ event: 'message_created', event_id: 'MSG2' }));
  await withoutConversation.service.processPending();
  assert.equal(withoutConversation.pool.rows[0].status, 'processed');
  assert.equal(withoutConversation.messages.length, 0);
});

test('non-reservation events are recorded as ignored without touching Hostex', async () => {
  const { service, pool, calls } = createService();
  await service.receive(parseHostexWebhook({ event: 'review_created', event_id: 'M1' }));
  await service.processPending();
  assert.equal(pool.rows[0].status, 'ignored');
  assert.equal(calls.length, 0);
});

test('failed processing is retried with backoff and gives up after five attempts', async () => {
  let attempts = 0;
  const { service, pool } = createService({
    sync: async () => {
      attempts += 1;
      throw new Error('Hostex 503 Bearer secret-token https://api.hostex.io/v3/reservations');
    },
  });
  await service.receive(parseHostexWebhook({ event: 'reservation_created', event_id: 'F1', reservation_code: 'R-9' }));
  await service.processPending();

  const row = pool.rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.ok(row.next_attempt_at > Date.now());
  assert.doesNotMatch(row.last_error, /secret-token|https?:/);

  for (let index = 0; index < 4; index += 1) {
    row.next_attempt_at = 0;
    await service.processPending();
  }
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 5);
  row.next_attempt_at = 0;
  await service.processPending();
  assert.equal(row.attempts, 5);
  assert.equal(attempts, 5);
});

test('scheduled processing is a no-op while the webhook secret is not configured', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  const { service } = createService({ pool, secret: '' });
  assert.equal(service.isEnabled(), false);
  await service.handleScheduledProcessing();
});

test('controller hides the endpoint when disabled and rejects bad secrets or payloads', async () => {
  const disabled = new HostexWebhookController(createService({ secret: '' }).service);
  await assert.rejects(disabled.receive(SECRET, { event: 'reservation_created' }), { status: 404 });

  const { service, pool } = createService();
  const controller = new HostexWebhookController(service);
  await assert.rejects(controller.receive('wrong', { event: 'reservation_created' }), { status: 401 });
  await assert.rejects(controller.receive(undefined, { event: 'reservation_created' }), { status: 401 });
  await assert.rejects(controller.receive(SECRET, { nope: true }), { status: 400 });
  assert.equal(pool.rows.length, 0);

  assert.deepEqual(
    await controller.receive(SECRET, { event: 'review_created', event_id: 'RV1' }),
    { received: true, duplicate: false },
  );
});

// Optional real PostgreSQL engine test: set PGLITE_MODULE to an installed @electric-sql/pglite.
test('webhook inbox migration is repeatable, deduplicates and hides the table', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    const migration = readFileSync(join(__dirname, '../migrations/20261021160000_hostex_webhook_events.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const insert = `INSERT INTO hostex_webhook_events (dedupe_key, event_type) VALUES ('event:1', 'reservation_created')
                    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`;
    assert.equal((await db.query(insert)).rows.length, 1);
    assert.equal((await db.query(insert)).rows.length, 0);
    await assert.rejects(db.query(`UPDATE hostex_webhook_events SET status = 'weird'`), /check/i);
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM hostex_webhook_events'), /permission denied/);
  } finally {
    await db.close();
  }
});
