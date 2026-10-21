const test = require('node:test');
const assert = require('node:assert/strict');
const { StatisticsService } = require('../dist/statistics/statistics.service');

test('combines Hostex reservations, ledger, availability, reviews and tasks for the statistics API', async () => {
  const calls = [];
  const pool = {
    query: async (sql, params) => {
      calls.push({ source: 'database', sql, params });
      return { rows: [{ id: 'apartment-uuid', name: 'Góry', hostex_property_id: 12761007 }] };
    },
  };
  const hostex = {
    getReservations: async (query) => {
      calls.push({ source: 'reservations', query });
      return { total: 1, reservations: [{
        reservation_code: 'R-1', stay_code: 'S-1', property_id: 12761007, channel_type: 'booking.com',
        check_in_date: '2026-10-01', check_out_date: '2026-10-03', number_of_guests: 2,
        number_of_adults: 2, number_of_children: 0, number_of_infants: 0, number_of_pets: 0,
        status: 'accepted', booked_at: '2026-09-01T12:00:00Z', created_at: '2026-09-01T12:00:00Z',
        rates: { total_rate: { amount: 300, currency: 'PLN' } },
      }] };
    },
    getTransactions: async (query) => {
      calls.push({ source: 'transactions', query });
      return { total: 1, transactions: [{
        id: 1, direction: 'income', amount: 300, currency: 'PLN', status: 'paid',
        action_at: '2026-10-01T09:00:00Z', item_name: 'Rezerwacja', property_id: 12761007,
      }] };
    },
    getAvailabilities: async (query) => {
      calls.push({ source: 'availability', query });
      return { properties: [{ id: 12761007, availabilities: [
        { date: '2026-10-01', available: false }, { date: '2026-10-02', available: false },
      ] }] };
    },
    getReviews: async (query) => {
      calls.push({ source: 'reviews', query });
      return { total: 1, reviews: [{ rating: 9, channel_type: 'booking.com' }] };
    },
    getTasks: async (query) => {
      calls.push({ source: 'tasks', query });
      return { total: 1, tasks: [{ type: 'cleaning', status: 'completed', fee: 50, currency: 'PLN' }] };
    },
  };

  const result = await new StatisticsService(pool, hostex).summary({ from: '2026-10-01', to: '2026-10-03' });

  assert.equal(result.summary.reservations, 1);
  assert.equal(result.summary.occupancyPercent, 100);
  assert.deepEqual(result.finances.paidIncome, { PLN: 300 });
  assert.equal(result.reviews.byChannel[0].averageScore, 9);
  assert.equal(result.tasks.completed, 1);
  assert.equal(result.finances.complete, true);
  assert.equal(result.reviews.complete, true);
  assert.equal(result.tasks.complete, true);
  const reservationCalls = calls.filter((call) => call.source === 'reservations');
  assert.equal(reservationCalls.length, 2);
  assert.equal(reservationCalls[0].query.startCheckInDate, '2026-10-01');
  assert.equal(reservationCalls[0].query.endCheckInDate, '2026-10-02');
  assert.equal(reservationCalls[0].query.startCheckOutDate, undefined);
  assert.equal(reservationCalls[1].query.startCheckOutDate, '2026-10-01');
  assert.equal(reservationCalls[1].query.endCheckOutDate, '2026-10-02');
  assert.equal(reservationCalls[1].query.startCheckInDate, undefined);
  assert.equal(calls.find((call) => call.source === 'transactions').query.endDate, '2026-10-02');
});
