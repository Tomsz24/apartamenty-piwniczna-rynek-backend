const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');

const { BadGatewayException, BadRequestException, GatewayTimeoutException } = require('@nestjs/common');
const {
  arrivalDeliveryChannel,
  renderArrivalMessage,
  hasUnfilledPlaceholders,
  formatValidity,
  classifyHostexSendError,
} = require('../dist/arrival-messages/arrival-message.domain');
const { ArrivalMessagesService } = require('../dist/arrival-messages/arrival-messages.service');

const TEMPLATE = `Dzień dobry
Kod dostępu do Państwa apartamentu (Apartament z widokiem na góry) to {{apartment_access_code}}

Kod dostępu do głównych drzwi do budynku to 1407#

Kody będą ważne
Od {{access_code_valid_from}}
Do {{access_code_valid_until}}`;

test('booking and other channel stays use the Hostex chat, manual and direct stays iMessage', () => {
  assert.equal(arrivalDeliveryChannel({ origin: 'hostex', channelType: 'booking.com', conversationId: 'c1' }), 'hostex_chat');
  assert.equal(arrivalDeliveryChannel({ origin: 'hostex', channelType: 'airbnb', conversationId: 'c1' }), 'hostex_chat');
  assert.equal(arrivalDeliveryChannel({ origin: 'hostex', channelType: 'hostex_direct', conversationId: 'c1' }), 'imessage');
  assert.equal(arrivalDeliveryChannel({ origin: 'hostex', channelType: 'booking.com', conversationId: null }), 'imessage');
  assert.equal(arrivalDeliveryChannel({ origin: 'manual', channelType: null, conversationId: null }), 'imessage');
});

test('renders the template with the code and Warsaw validity, across the DST change', () => {
  const text = renderArrivalMessage(TEMPLATE, {
    accessCode: '0482',
    validFrom: new Date('2026-10-23T10:00:00Z'),
    validUntil: new Date('2026-10-26T10:00:00Z'),
    timeZone: 'Europe/Warsaw',
  });
  assert.match(text, /widokiem na góry\) to 0482#\n/);
  // A template that already writes "#" after the code does not get a second one.
  assert.equal(renderArrivalMessage('Kod: {{apartment_access_code}}#', {
    accessCode: '0482', validFrom: new Date(), validUntil: new Date(), timeZone: 'Europe/Warsaw',
  }), 'Kod: 0482#');
  assert.match(text, /Od 12:00 23-10-2026\nDo 11:00 26-10-2026$/);
  assert.match(text, /1407#/);
  assert.equal(hasUnfilledPlaceholders(text), false);
  assert.equal(hasUnfilledPlaceholders(renderArrivalMessage('Kod {{unknown_field}}', {
    accessCode: '1', validFrom: new Date(), validUntil: new Date(), timeZone: 'Europe/Warsaw',
  })), true);
  assert.equal(formatValidity(new Date('2026-07-01T09:05:00Z'), 'Europe/Warsaw'), '11:05 01-07-2026');
});

test('only a Hostex rejection counts as certainly not sent', () => {
  assert.equal(classifyHostexSendError(new BadRequestException('Hostex odrzucił parametry żądania')), 'failed');
  assert.equal(classifyHostexSendError(new BadGatewayException('Hostex odrzucił żądanie kodem 1234')), 'failed');
  assert.equal(classifyHostexSendError(new GatewayTimeoutException('Hostex nie potwierdził zmiany')), 'uncertain');
  assert.equal(classifyHostexSendError(new BadGatewayException('Nie udało się połączyć z Hostex.')), 'uncertain');
  assert.equal(classifyHostexSendError(new BadGatewayException('Hostex odpowiedział HTTP 502 podczas zapisu')), 'uncertain');
});

const STAY = {
  id: 'res-1', status: 'confirmed', origin: 'hostex', start_date: '2026-10-23', end_date: '2026-10-25', guest_name: 'Anna',
  guest_phone: null, channel_type: 'booking.com', conversation_id: 'conv-1', arrival_message_sent_at: null,
  apartment_id: 'apt-1', access_code_time_zone: 'Europe/Warsaw', label: 'Góry · Anna · 23.10–25.10.2026',
  template_body: TEMPLATE, attachment_bucket_id: 'arrival-message-assets', attachment_path: 'apartments-map.jpg',
};

// In-memory stand-in for the queries ArrivalMessagesService issues.
function createPool(stay = STAY) {
  const state = { stay: { ...stay }, delivery: null, events: [] };
  const query = async (text, params = []) => {
    if (text.includes('FROM reservations AS reservation') && text.includes('template.body')) {
      return { rows: [{ ...state.stay }] };
    }
    if (text.includes('SELECT status, image_sent')) return { rows: state.delivery ? [{ ...state.delivery, updated_at: new Date() }] : [] };
    if (text.includes('INSERT INTO arrival_message_deliveries')) {
      if (!state.delivery) {
        state.delivery = { status: 'sending', attempts: 1, image_sent: false, last_error: null, triggered_by: params[2] };
        return { rowCount: 1, rows: [{ id: 'd1' }] };
      }
      if (state.delivery.status === 'failed' && state.delivery.attempts < params[3]) {
        Object.assign(state.delivery, { status: 'sending', attempts: state.delivery.attempts + 1 });
        return { rowCount: 1, rows: [{ id: 'd1' }] };
      }
      return { rowCount: 0, rows: [] };
    }
    if (text.includes("WHERE status = 'sending' AND updated_at <")) {
      if (state.delivery?.status !== 'sending' || !state.delivery.stale) return { rowCount: 0, rows: [] };
      state.delivery.status = 'uncertain';
      return { rowCount: 1, rows: [{ reservation_id: state.stay.id, stay_start_date: state.stay.start_date }] };
    }
    if (text.includes('UPDATE arrival_message_deliveries')) {
      Object.assign(state.delivery, { status: params[2], image_sent: params[3], last_error: params[4] });
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('UPDATE reservations SET arrival_message_sent_at')) {
      state.stay.arrival_message_sent_at = new Date('2026-10-23T08:00:00Z');
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('INSERT INTO notification_events')) {
      if (!state.events.some((event) => event.key === params[0])) {
        state.events.push({ key: params[0], type: params[1], priority: params[2], title: params[5], body: params[6] });
      }
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  return { state, query };
}

function createService({ pool = createPool(), code = { status: 'active', code: '0482', validFrom: '2026-10-23T10:00:00.000Z', validUntil: '2026-10-25T09:00:00.000Z' }, hostex = {}, enabled = true, listCodes } = {}) {
  const sent = [];
  const service = new ArrivalMessagesService(
    pool,
    { list: listCodes ?? (async () => ({ items: code ? [code] : [] })) },
    {
      sendMessage: hostex.sendMessage ?? (async (conversationId, message) => { sent.push({ conversationId, message }); return {}; }),
      sendImage: hostex.sendImage ?? (async (conversationId, jpeg) => { sent.push({ conversationId, image: jpeg.length }); return {}; }),
      getConversation: hostex.getConversation ?? (async () => ({ messages: [] })),
    },
    { get: (key) => ({ ARRIVAL_MESSAGE_AUTO_SEND_ENABLED: String(enabled), SUPABASE_URL: 'https://example.supabase.co/' })[key] },
  );
  service.imageCheckDelayMs = 0;
  return { service, pool, sent };
}

function stubMapFetch(t, ok = true) {
  const original = global.fetch;
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://example.supabase.co/storage/v1/object/public/arrival-message-assets/apartments-map.jpg');
    return ok
      ? { ok: true, arrayBuffer: async () => Buffer.from('jpeg-bytes') }
      : { ok: false, status: 404 };
  };
  t.after(() => { global.fetch = original; });
}

test('preview shows the rendered message, the map and that it will go out automatically', async () => {
  const { service } = createService();
  const preview = await service.preview('res-1');
  assert.equal(preview.channel, 'hostex_chat');
  assert.equal(preview.autoSend, true);
  assert.match(preview.text, /to 0482#/);
  assert.equal(preview.mapImageUrl, 'https://example.supabase.co/storage/v1/object/public/arrival-message-assets/apartments-map.jpg');
  assert.equal(preview.missingReason, null);
});

test('sends text then map, marks the stay as sent and notifies once', async (t) => {
  stubMapFetch(t);
  const { service, pool, sent } = createService();
  const result = await service.sendViaHostex('res-1', 'automation');
  assert.deepEqual(sent.map((item) => Object.keys(item).sort()), [['conversationId', 'message'], ['conversationId', 'image']]);
  assert.match(sent[0].message, /to 0482#/);
  assert.equal(pool.state.delivery.status, 'sent');
  assert.equal(pool.state.delivery.image_sent, true);
  assert.ok(result.sentAt);
  assert.deepEqual(pool.state.events.map((event) => [event.type, event.priority]), [['arrival_message_sent', 'low']]);
  await assert.rejects(service.sendViaHostex('res-1', 'automation'), { status: 409 });
  assert.equal(sent.length, 2);
});

test('a missing map still counts the code message as sent and says so', async (t) => {
  stubMapFetch(t, false);
  const { service, pool, sent } = createService();
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(sent.length, 1);
  assert.equal(pool.state.delivery.status, 'sent');
  assert.equal(pool.state.delivery.image_sent, false);
  assert.equal(pool.state.events[0].title, 'Wysłano wiadomość, ale bez mapki');
});

test('without a door code nothing is sent, the owner is alerted and a later run may retry', async (t) => {
  stubMapFetch(t);
  const { service, pool, sent } = createService({ code: null });
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(sent.length, 0);
  assert.equal(pool.state.delivery.status, 'failed');
  assert.deepEqual(pool.state.events.map((event) => [event.type, event.priority]), [['arrival_message_failed', 'critical']]);
  assert.equal(pool.state.stay.arrival_message_sent_at, null);
  // A retry happens on the next run (the code may have been created meanwhile); no second push.
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(pool.state.delivery.attempts, 2);
  assert.equal(pool.state.events.length, 1);
});

test('an unconfirmed Hostex send is never retried automatically', async () => {
  const { service, pool } = createService({
    hostex: { sendMessage: async () => { throw new GatewayTimeoutException('timeout'); } },
  });
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(pool.state.delivery.status, 'uncertain');
  assert.equal(pool.state.stay.arrival_message_sent_at, null);
  assert.equal(pool.state.events[0].title, 'Sprawdź czat z gościem');
  await assert.rejects(service.sendViaHostex('res-1', 'automation'), { status: 409 });
});

test('manual and direct stays cannot be sent through the Hostex chat', async () => {
  const { service } = createService({ pool: createPool({ ...STAY, channel_type: 'hostex_direct', conversation_id: null, guest_phone: '+48600100200' }) });
  const preview = await service.preview('res-1');
  assert.equal(preview.channel, 'imessage');
  assert.equal(preview.autoSend, false);
  assert.equal(preview.guestPhone, '+48600100200');
  await assert.rejects(service.sendViaHostex('res-1', 'admin'), { status: 400 });
});

test('the schedule does nothing while automatic sending is disabled', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  const { service } = createService({ pool, enabled: false });
  await service.handleScheduledSend();
});

// Optional real PostgreSQL engine test: set PGLITE_MODULE to an installed @electric-sql/pglite.
test('arrival delivery migration is repeatable, one row per stay, hidden from Data API roles', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE notification_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text);
      INSERT INTO reservations(id) VALUES ('00000000-0000-0000-0000-0000000000a1');`);
    const migration = readFileSync(join(__dirname, '../migrations/20261022100000_arrival_message_deliveries.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const insert = `INSERT INTO arrival_message_deliveries (reservation_id, stay_start_date, triggered_by)
                    VALUES ('00000000-0000-0000-0000-0000000000a1', '2026-10-23', 'automation')
                    ON CONFLICT (reservation_id, stay_start_date) DO NOTHING RETURNING id`;
    assert.equal((await db.query(insert)).rows.length, 1);
    assert.equal((await db.query(insert)).rows.length, 0);
    await db.query(`INSERT INTO notification_events(event_type) VALUES ('arrival_message_failed'), ('arrival_message_sent')`);
    await assert.rejects(db.query(`UPDATE arrival_message_deliveries SET status = 'maybe'`), /check/i);
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM arrival_message_deliveries'), /permission denied/);
  } finally {
    await db.close();
  }
});

test('a failure while preparing the text leaves the delivery retryable, not stuck in sending', async (t) => {
  stubMapFetch(t);
  let broken = true;
  const { service, pool, sent } = createService({
    listCodes: async () => {
      if (broken) throw new Error('connection terminated');
      return { items: [{ status: 'active', code: '0482', validFrom: '2026-10-23T10:00:00.000Z', validUntil: '2026-10-25T09:00:00.000Z' }] };
    },
  });
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(pool.state.delivery.status, 'failed');
  assert.match(pool.state.delivery.last_error, /connection terminated/);
  broken = false;
  await service.sendViaHostex('res-1', 'admin:owner');
  assert.equal(pool.state.delivery.status, 'sent');
  assert.equal(sent.filter((item) => item.message).length, 1);
});

test('the schedule turns an interrupted send into "uncertain" instead of leaving it stuck', async () => {
  const pool = createPool();
  pool.state.delivery = { status: 'sending', attempts: 1, image_sent: false, last_error: null, stale: true };
  const wrapped = { query: async (text, params) => (text.includes('arrival_message_sent_at IS NULL') ? { rows: [] } : pool.query(text, params)) };
  const { service } = createService({ pool: wrapped });
  await service.handleScheduledSend();
  assert.equal(pool.state.delivery.status, 'uncertain');
  assert.deepEqual(
    pool.state.events.map((event) => [event.key, event.priority, event.title]),
    [['arrival_message:res-1:2026-10-23:uncertain', 'critical', 'Sprawdź czat z gościem']],
  );
});

test('a template must keep the door code and may only use known fields', () => {
  const { arrivalTemplateError } = require('../dist/arrival-messages/arrival-message.domain');
  assert.equal(arrivalTemplateError(TEMPLATE), null);
  assert.match(arrivalTemplateError('   '), /pusty/);
  assert.match(arrivalTemplateError('Dzień dobry, zapraszamy'), /apartment_access_code/);
  assert.match(arrivalTemplateError('Kod {{apartment_access_code}} {{guest_name}}'), /guest_name/);
});

test('saving a template trims it and keeps the map attachment untouched', async () => {
  const queries = [];
  const pool = {
    query: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('FROM apartments')) return { rows: [{}] };
      return { rows: [{ body: params[1], updated_at: new Date('2026-10-23T07:00:00Z') }] };
    },
  };
  const { service } = createService({ pool });
  const saved = await service.saveTemplate('apt-1', '  Kod: {{apartment_access_code}}  ');
  assert.equal(saved.body, 'Kod: {{apartment_access_code}}');
  assert.equal(saved.placeholders[0].key, 'apartment_access_code');
  const upsert = queries.find((query) => query.text.includes('ON CONFLICT'));
  assert.doesNotMatch(upsert.text, /attachment/);
  await assert.rejects(service.saveTemplate('apt-1', 'bez kodu'), BadRequestException);
});

test('fixed hours with stay dates as fields, like the owner writes the message', async () => {
  const template = 'Kod: {{apartment_access_code}}\nOd 15:00 {{arrival_date}}\nDo 10:00 {{departure_date}}';
  const { service } = createService({ pool: createPool({ ...STAY, template_body: template }) });
  const preview = await service.preview('res-1');
  assert.equal(preview.text, 'Kod: 0482#\nOd 15:00 23-10-2026\nDo 10:00 25-10-2026');
  const { arrivalTemplateError } = require('../dist/arrival-messages/arrival-message.domain');
  assert.equal(arrivalTemplateError(template), null);
});

test('a map that Hostex answers too late but shows up in the chat counts as sent', async (t) => {
  stubMapFetch(t);
  const { service, pool } = createService({
    hostex: {
      sendImage: async () => { throw new GatewayTimeoutException('Hostex nie potwierdził zmiany.'); },
      getConversation: async () => ({ messages: [
        { id: 'img', isOutgoing: true, text: '', attachments: ['https://oss.example.test/map.jpeg'], sentAt: new Date().toISOString() },
      ] }),
    },
  });
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(pool.state.delivery.status, 'sent');
  assert.equal(pool.state.delivery.image_sent, true);
  assert.equal(pool.state.delivery.last_error, null);
  assert.equal(pool.state.events[0].title, 'Wysłano wiadomość przyjazdową');
});

test('a map that never shows up in the chat is still reported as missing', async (t) => {
  stubMapFetch(t);
  const { service, pool } = createService({
    hostex: { sendImage: async () => { throw new GatewayTimeoutException('Hostex nie potwierdził zmiany.'); } },
  });
  await service.sendViaHostex('res-1', 'automation');
  assert.equal(pool.state.delivery.image_sent, false);
  assert.equal(pool.state.events[0].title, 'Wysłano wiadomość, ale bez mapki');
});
