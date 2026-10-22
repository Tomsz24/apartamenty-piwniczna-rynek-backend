const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ReservationEmailService } = require('../dist/notifications/reservation-email.service');
const { renderReservationEmail } = require('../dist/notifications/reservation-email.template');
const sample = { id: 'reservation-1', apartment_name: 'Widok na góry', start_date: '2026-12-10', end_date: '2026-12-14', guest_name: '<script>alert(1)</script>', status: 'confirmed', guest_count: 2 };
const settings = { RESERVATION_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'test-key', RESERVATION_EMAIL_FROM: 'rezerwacje@example.com', RESERVATION_EMAIL_TO: 'owner@example.com', RESERVATION_EMAIL_START_AT: '2026-10-21T00:00:00Z' };
function harness(job, overrides = {}) {
  const queries = [];
  const client = { query: async (sql, values) => { queries.push({sql, values}); return { rows: sql.startsWith('SELECT *') ? (job ? [job] : []) : [] }; }, release() {} };
  const config = { get: key => ({...settings, ...overrides})[key] };
  return { queries, service: new ReservationEmailService({ connect: async () => client }, config) };
}
function job() { return { id: 'event-1', attempts: 0, event_type: 'new_reservation', snapshot: sample, previous_snapshot: null }; }

test('all templates escape untrusted HTML and show Polish dates', () => {
  for (const event_type of ['new_reservation','reservation_modified','reservation_cancelled']) {
    const rendered = renderReservationEmail({ event_type, snapshot: sample, previous_snapshot: {...sample, guest_count: 1} });
    assert.ok(rendered.html.includes('&lt;script&gt;'));
    assert.ok(!rendered.html.includes('<script>'));
    assert.ok(rendered.text.includes('10.12.2026'));
    if (event_type === 'reservation_modified') assert.ok(rendered.text.includes('Liczba gości: 1 → 2'));
  }
});
test('disabled sender never touches database', async () => {
  const { service, queries } = harness(job(), { RESERVATION_EMAIL_ENABLED: 'false' });
  await service.dispatch(); assert.equal(queries.length, 0);
});
test('enabled sender rejects missing and invalid configuration', () => {
  for (const values of [{ RESEND_API_KEY: '' }, { RESERVATION_EMAIL_START_AT: 'bad' }, { RESERVATION_EMAIL_TO: 'a@example.com, not-an-email' }, { RESERVATION_EMAIL_TO: ' , ' }]) {
    assert.throws(() => harness(job(), values).service.onModuleInit());
  }
  harness(job()).service.onModuleInit();
});
test('sender persists request before send and addresses owner, never guest', async t => {
  const { service, queries } = harness(job());
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.ok(queries.some(q => q.sql.includes('request=$2')));
    const request = JSON.parse(options.body);
    assert.deepEqual(request.to, ['owner@example.com']);
    assert.equal(options.headers['Idempotency-Key'], 'reservation/event-1');
    return { ok: true, json: async () => ({id: 'resend-id'}) };
  });
  await service.dispatch();
  assert.ok(queries.some(q => q.sql.includes("status='sent'") && q.values[1] === 'resend-id'));
});
test('retry preserves original body despite recipient/template config changes', async t => {
  const original = { from: 'old@example.com', to: ['old-owner@example.com'], subject: 'old', text: 'old', html: '<p>old</p>' };
  const { service } = harness({...job(), attempts: 1, request: original, first_attempt_at: new Date().toISOString()});
  t.mock.method(global, 'fetch', async (_, options) => {
    assert.deepEqual(JSON.parse(options.body), original);
    return {ok: true, json: async () => ({ id: 'same-id' })};
  });
  await service.dispatch();
});
test('429 retries; 403 fails without logging provider response or secrets', async t => {
  for (const status of [429,403]) {
    const { service, queries } = harness(job());
    const mock = t.mock.method(global, 'fetch', async () => ({ok: false, status, headers: new Headers({'retry-after':'120'})}));
    await service.dispatch();
    const update = queries.find(q => q.sql.includes('last_error=$3'));
    assert.equal(update.values[1], status === 429 ? 'pending' : 'failed');
    assert.equal(update.values[2], `Resend HTTP ${status}`);
    mock.mock.restore();
  }
});
test('network timeout retries and expired idempotency window stops', async t => {
  t.mock.method(global, 'fetch', async () => { throw new Error('secret provider response'); });
  let h = harness(job()); await h.service.dispatch();
  assert.ok(h.queries.some(q => q.values?.includes('Email delivery failed or unconfirmed')));
  h = harness({...job(), first_attempt_at: new Date(Date.now() - 24*3600000).toISOString()});
  await h.service.dispatch();
  assert.ok(h.queries.some(q => q.sql.includes('Idempotency window expired')));
});

test('omits pets and zero head counts, shows money with currency and Polish payment status', () => {
  // The cancellation email from the first production test (22.10.2026).
  const snapshot = {
    id: '9b9b3340-7f21-465c-9b6b-5552315d3993', apartment_name: 'Apartament - Widok na rynek',
    start_date: '2026-10-22', end_date: '2026-10-23', guest_name: 'Tomasz Wojciechowski',
    guest_count: 2, adults: 2, children: 0, infants: 0, pets: 0, child_ages: [],
    guest_phone: '512 251 253', status: 'cancelled', total_rate_amount: 448, amount_received: 0,
    currency: 'PLN', payment_status: 'unreceived',
  };
  const { text } = renderReservationEmail({ event_type: 'reservation_cancelled', snapshot, previous_snapshot: null });
  // Intl keeps the amount and "zł" together with a non-breaking space.
  const plain = (value) => value.replace(/[\u00a0\u202f]/g, ' ');
  const lines = plain(text).split('\n');
  assert.ok(lines.includes('Liczba gości: 2'));
  assert.ok(lines.includes('Dorośli: 2'));
  for (const hidden of ['Dzieci', 'Niemowlęta', 'Zwierzęta', 'Wiek dzieci', 'Waluta']) {
    assert.equal(lines.some((line) => line.startsWith(`${hidden}:`)), false, hidden);
  }
  assert.ok(lines.includes('Wartość rezerwacji: 448,00 zł'));
  assert.ok(lines.includes('Otrzymano: 0,00 zł'));
  assert.ok(lines.includes('Status płatności: Nieopłacona'));
  assert.ok(lines.includes('Status: Anulowana'));

  // A change down to zero is still reported in the diff; pets never are.
  const modified = plain(renderReservationEmail({
    event_type: 'reservation_modified',
    snapshot: { ...snapshot, status: 'confirmed', children: 0, pets: 1, total_rate_amount: 500 },
    previous_snapshot: { ...snapshot, status: 'confirmed', children: 1, pets: 0 },
  }).text);
  assert.ok(modified.includes('Dzieci: 1 → 0'));
  assert.ok(modified.includes('Wartość rezerwacji: 448,00 zł → 500,00 zł'));
  assert.equal(modified.includes('Zwierzęta'), false);
});

test('sends a separate email to every address on the comma-separated recipient list', async (t) => {
  const { recipientList } = require('../dist/notifications/reservation-email.service');
  assert.deepEqual(recipientList(' owner@example.com, family@example.com ,owner@example.com '), ['owner@example.com', 'family@example.com']);
  const original = global.fetch;
  let body; let url; let headers;
  global.fetch = async (target, init) => {
    url = target; headers = init.headers; body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ data: [{ id: 'resend-1' }, { id: 'resend-2' }] }) };
  };
  t.after(() => { global.fetch = original; });
  const { service } = harness(job(), { RESERVATION_EMAIL_TO: 'owner@example.com, family@example.com' });
  service.onModuleInit();
  await service.dispatch();
  assert.equal(url, 'https://api.resend.com/emails/batch');
  assert.equal(headers['Idempotency-Key'], 'reservation/event-1');
  assert.deepEqual(body.map((email) => email.to), [['owner@example.com'], ['family@example.com']]);
  assert.equal(body[0].subject, body[1].subject);
  assert.equal(body[0].html, body[1].html);
});
