const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { CreateReservationDto } = require('../dist/reservations/reservations.dto');
const { ReservationsService } = require('../dist/reservations/reservations.service');
const {
  classifyRangeCoverage,
  isValidIsoDate,
  rangesOverlap,
  selectUniqueDateMatch,
  validateDateRange,
} = require('../dist/reservations/reservations.domain');

test('accepts a valid stay and rejects impossible or reversed dates', () => {
  assert.equal(isValidIsoDate('2026-02-28'), true);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(validateDateRange('2026-08-10', '2026-08-12'), null);
  assert.match(validateDateRange('2026-08-12', '2026-08-10'), /późniejsza/);
  assert.match(validateDateRange('10.08.2026', '2026-08-12'), /YYYY-MM-DD/);
});

test('returns PostgreSQL DATE values without shifting them through UTC', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    apartment_id: '22222222-2222-4222-8222-222222222222',
    apartment_name: 'Widok na góry',
    origin: 'hostex',
    status: 'confirmed',
    start_date: new Date(2026, 9, 23),
    end_date: new Date(2026, 9, 25),
    guest_name: 'Milena Gołuchowska',
    guest_count: 2,
    adults: 2,
    children: 0,
    infants: 0,
    pets: 0,
    metadata: {},
    created_by: 'hostex-sync',
    created_at: new Date('2026-10-21T12:00:00.000Z'),
    updated_at: new Date('2026-10-21T12:00:00.000Z'),
    version: 1,
  };
  const service = new ReservationsService({ query: async () => ({ rows: [row] }) });

  const [reservation] = await service.list({});
  assert.equal(reservation.startDate, '2026-10-23');
  assert.equal(reservation.endDate, '2026-10-25');
});

test('allows back-to-back stays but detects real overlap', () => {
  assert.equal(rangesOverlap('2026-08-10', '2026-08-12', '2026-08-12', '2026-08-15'), false);
  assert.equal(rangesOverlap('2026-08-10', '2026-08-13', '2026-08-12', '2026-08-15'), true);
});

test('matches a changed source identifier only when dates identify one reservation', () => {
  const reservation = { id: 'one', startDate: '2026-08-10', endDate: '2026-08-12' };
  assert.equal(
    selectUniqueDateMatch([reservation], '2026-08-10', '2026-08-12'),
    reservation,
  );

  assert.equal(
    selectUniqueDateMatch(
      [reservation, { id: 'duplicate', startDate: '2026-08-10', endDate: '2026-08-12' }],
      '2026-08-10',
      '2026-08-12',
    ),
    null,
  );
});

test('classifies one iCal block covering adjacent real reservations', () => {
  assert.equal(
    classifyRangeCoverage(
      [
        { startDate: '2026-08-10', endDate: '2026-08-12' },
        { startDate: '2026-08-12', endDate: '2026-08-15' },
      ],
      '2026-08-10',
      '2026-08-15',
    ),
    'covered',
  );

  assert.equal(
    classifyRangeCoverage(
      [
        { startDate: '2026-08-10', endDate: '2026-08-11' },
        { startDate: '2026-08-13', endDate: '2026-08-15' },
      ],
      '2026-08-10',
      '2026-08-15',
    ),
    'partial',
  );
});

test('validates the payload used by admin and mobile clients', async () => {
  const valid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    status: 'confirmed',
    guestCount: 3,
    adults: 2,
    children: 1,
    totalRateAmount: 1500,
  });
  assert.equal((await validate(valid)).length, 0);

  const invalid = plainToInstance(CreateReservationDto, {
    apartmentId: 'not-an-id',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    status: 'unknown',
  });
  const errors = await validate(invalid);
  assert.deepEqual(
    errors.map((error) => error.property).sort(),
    ['adults', 'apartmentId', 'status', 'totalRateAmount'],
  );
});

test('validates optional guest contact details and child ages', async () => {
  const valid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    adults: 1,
    children: 2,
    childAges: [0, 12],
    totalRateAmount: 1500,
    guestPhone: '+48123123123',
    guestEmail: 'guest@example.com',
  });
  assert.equal((await validate(valid)).length, 0);

  const invalid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    childAges: [4, 25],
    guestEmail: 'not-an-email',
  });
  const errors = await validate(invalid);
  assert.deepEqual(errors.map((error) => error.property).sort(), [
    'adults',
    'childAges',
    'guestEmail',
    'totalRateAmount',
  ]);
});

test('requires the app-calculated manual reservation total and accepts two decimal places', async () => {
  const valid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    adults: 1,
    totalRateAmount: '1250.50',
    amountReceived: '500',
  });
  assert.equal((await validate(valid)).length, 0);

  const invalid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    adults: 1,
    totalRateAmount: '1250.555',
    amountReceived: '-10',
  });
  assert.deepEqual((await validate(invalid)).map((error) => error.property).sort(), [
    'amountReceived',
    'totalRateAmount',
  ]);
});

test('rejects manual reservations above four guests or without an adult before Hostex write', async () => {
  let hostexCreateCalled = false;
  const service = new ReservationsService(
    { query: async () => ({ rows: [] }) },
    { create: async () => { hostexCreateCalled = true; } },
  );
  const base = {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-22',
    guestName: 'Jan Kowalski',
    totalRateAmount: 1000,
    status: 'confirmed',
  };

  await assert.rejects(
    service.createManual({ ...base, adults: 4, children: 1 }, 'admin'),
    /maksymalnie 4 osoby/,
  );
  await assert.rejects(
    service.createManual({ ...base, adults: 0, children: 4 }, 'admin'),
    /przynajmniej jednego dorosłego/,
  );
  assert.equal(hostexCreateCalled, false);
});
