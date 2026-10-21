const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStatistics } = require('../dist/statistics/statistics.domain');

test('aggregates occupancy, stay value, Hostex cashflow, reviews and tasks without mixing currencies', () => {
  const result = buildStatistics({
    from: '2026-10-01',
    to: '2026-10-04',
    apartments: [
      { id: 'market', name: 'Rynek', hostexPropertyId: 101 },
      { id: 'mountain', name: 'Góry', hostexPropertyId: 102 },
    ],
    stays: [
      {
        reservationCode: 'a', apartmentId: 'market', channelType: 'booking.com', status: 'accepted',
        checkInDate: '2026-10-01', checkOutDate: '2026-10-03', bookedAt: '2026-09-01T12:00:00Z', cancelledAt: null,
        guestCount: 2, adults: 2, children: 0, infants: 0, pets: 0, amount: 200, currency: 'EUR',
      },
      {
        reservationCode: 'b', apartmentId: 'mountain', channelType: 'hostex_direct', status: 'accepted',
        checkInDate: '2026-10-02', checkOutDate: '2026-10-04', bookedAt: '2026-09-20T12:00:00Z', cancelledAt: null,
        guestCount: 3, adults: 2, children: 1, infants: 0, pets: 0, amount: 400, currency: 'PLN',
      },
      {
        reservationCode: 'c', apartmentId: 'market', channelType: 'booking.com', status: 'cancelled',
        checkInDate: '2026-10-02', checkOutDate: '2026-10-03', bookedAt: '2026-09-15T12:00:00Z', cancelledAt: '2026-10-02T10:00:00Z',
        guestCount: 2, adults: 2, children: 0, infants: 0, pets: 0, amount: 100, currency: 'PLN',
      },
    ],
    transactions: [
      { id: 'i1', direction: 'income', amount: 100, currency: 'PLN', status: 'paid', actionAt: '2026-10-01T12:00:00Z', itemName: 'room fee', paymentMethodName: 'Cash', propertyId: 101 },
      { id: 'i2', direction: 'income', amount: 40, currency: 'PLN', status: 'outstanding', actionAt: '2026-10-02T12:00:00Z', itemName: 'deposit', paymentMethodName: 'Cash', propertyId: 102 },
      { id: 'e1', direction: 'expense', amount: 20, currency: 'PLN', status: 'paid', actionAt: '2026-10-02T12:00:00Z', itemName: 'cleaning', paymentMethodName: 'Cash', propertyId: 102 },
    ],
    transactionsComplete: true,
    unavailableTransactionApartments: [],
    availabilityByProperty: {
      101: { availableByDate: { '2026-10-01': false, '2026-10-02': false, '2026-10-03': true } },
      102: { availableByDate: { '2026-10-01': false, '2026-10-02': false, '2026-10-03': false } },
    },
    availabilityComplete: true,
    reviews: [{ score: 9, channelType: 'booking.com' }, { score: 4.5, channelType: 'airbnb' }],
    reviewsComplete: true,
    unavailableReviewApartments: [],
    tasks: [
      { type: 'cleaning', status: 'completed', fee: 50, currency: 'PLN' },
      { type: 'maintenance', status: 'pending', fee: 25, currency: 'PLN' },
    ],
    tasksComplete: true,
    unavailableTaskApartments: [],
  });

  assert.equal(result.summary.reservations, 2);
  assert.equal(result.summary.cancellations, 1);
  assert.equal(result.summary.arrivals, 2);
  assert.equal(result.summary.departures, 1);
  assert.equal(result.summary.occupiedNights, 4);
  assert.equal(result.summary.blockedNights, 1);
  assert.equal(result.summary.sellableNights, 5);
  assert.equal(result.summary.occupancyPercent, 80);
  assert.deepEqual(result.summary.estimatedRoomRevenue, { EUR: 200, PLN: 400 });
  assert.deepEqual(result.summary.averageDailyRateByCurrency, { EUR: 100, PLN: 200 });
  assert.deepEqual(result.finances.paidIncome, { PLN: 100 });
  assert.deepEqual(result.finances.outstandingIncome, { PLN: 40 });
  assert.deepEqual(result.finances.netPaidCashflow, { PLN: 80 });
  assert.deepEqual(result.byApartment.find((row) => row.apartmentId === 'market').paidIncome, { PLN: 100 });
  assert.deepEqual(result.byApartment.find((row) => row.apartmentId === 'mountain').netPaidCashflow, { PLN: -20 });
  assert.equal(result.byDate[0].occupiedApartments, 1);
  assert.equal(result.byDate[0].sellableApartments, 1);
  assert.equal(result.byDate[0].occupancyPercent, 100);
  assert.deepEqual(result.byChannel.find((row) => row.channelType === 'booking.com').estimatedRoomRevenue, { EUR: 200 });
  assert.equal(result.reviews.byChannel.length, 2);
  assert.equal(result.tasks.completed, 1);
});

test('does not count cancelled task fees in the expected cost total', () => {
  const result = buildStatistics({
    from: '2026-10-01', to: '2026-10-02',
    apartments: [{ id: 'a', name: 'Rynek', hostexPropertyId: 1 }], stays: [], transactions: [],
    transactionsComplete: true, unavailableTransactionApartments: [], availabilityByProperty: {}, availabilityComplete: false,
    reviews: [], reviewsComplete: true, unavailableReviewApartments: [], tasks: [
      { type: 'cleaning', status: 'cancelled', fee: 100, currency: 'PLN' },
      { type: 'cleaning', status: 'pending', fee: 20, currency: 'PLN' },
    ],
    tasksComplete: true, unavailableTaskApartments: [],
  });

  assert.deepEqual(result.tasks.fees, { PLN: 20 });
  assert.equal(result.tasks.cancelled, 1);
});
