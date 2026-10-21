const test = require('node:test');
const assert = require('node:assert/strict');
const { HostexReservationWritesService } = require('../dist/hostex/hostex-reservation-writes.service');

function makeService({ channels = [{ id: 5840, name: 'Mobile App' }], methods = [{ id: 197, name: 'Cash' }] } = {}) {
  const created = [];
  const synced = [];
  const queries = [];
  const hostex = {
    listCustomChannels: async () => channels,
    listIncomeMethods: async () => methods,
    createDirectReservation: async (payload) => { created.push(payload); },
  };
  const sync = {
    syncReservationByChannelId: async (channelId) => {
      synced.push(channelId);
      return { reservationId: 'local-reservation-id', action: 'created' };
    },
  };
  const pool = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (/hostex_property_mappings/.test(sql)) return { rows: [{ hostex_property_id: '12761007' }] };
      return { rows: [] };
    },
  };
  return { service: new HostexReservationWritesService(pool, hostex, sync), created, synced, queries };
}

const reservation = {
  apartmentId: '406c804c-07fe-4e96-a349-58bfc4819e66',
  clientReservationId: 'b6831a51-1a3c-40b7-932f-a9f5404b77cc',
  startDate: '2027-05-10',
  endDate: '2027-05-12',
  status: 'confirmed',
  guestName: 'Jan Kowalski',
  guestCount: 3,
  adults: 2,
  children: 1,
  guestPhone: '+48123123123',
  totalRateAmount: 1200,
  amountReceived: 300,
};

test('creates and immediately imports a Hostex Direct reservation using Mobile App and Cash', async () => {
  const { service, created, synced, queries } = makeService();
  const result = await service.create(reservation);

  assert.deepEqual(result, {
    reservationId: 'local-reservation-id',
    clientChannelId: 'b6831a511a3c40b7932fa9f5404b77cc',
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].property_id, 12761007);
  assert.equal(created[0].custom_channel_id, 5840);
  assert.equal(created[0].income_method_id, 197);
  assert.equal(created[0].channel_id, result.clientChannelId);
  assert.equal(created[0].number_of_guests, 3);
  assert.equal(created[0].received_amount, 300);
  assert.deepEqual(synced, [result.clientChannelId]);
  assert.match(queries[1].sql, /start_date < \$3 AND end_date > \$2/);
});

test('does not create Hostex reservations with an unknown Mobile App channel', async () => {
  const { service, created } = makeService({ channels: [{ id: 8, name: 'Booking.com' }] });
  await assert.rejects(service.create(reservation), /Mobile App/);
  assert.equal(created.length, 0);
});

test('does not send blocked dates as guest reservations to Hostex', async () => {
  const { service, created } = makeService();
  await assert.rejects(service.create({ ...reservation, status: 'blocked' }), /tylko potwierdzone/);
  assert.equal(created.length, 0);
});
