const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { CreateReservationDto } = require('../dist/reservations/reservations.dto');
const {
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

test('validates the payload used by admin and mobile clients', async () => {
  const valid = plainToInstance(CreateReservationDto, {
    apartmentId: '00000000-0000-4000-8000-000000000000',
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    status: 'confirmed',
    guestCount: 3,
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
    ['apartmentId', 'status'],
  );
});
