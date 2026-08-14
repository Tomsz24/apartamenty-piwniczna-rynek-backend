const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { ConfigService } = require('@nestjs/config');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AccessCodeCryptoService } = require('../dist/access-codes/access-code-crypto.service');
const { AccessCodesService } = require('../dist/access-codes/access-codes.service');
const {
  decodeAccessCodeCursor,
  encodeAccessCodeCursor,
  buildAccessCodeValidity,
  formatDateInTimeZone,
  generateFourDigitCode,
  isAllowedFourDigitCode,
} = require('../dist/access-codes/access-codes.domain');
const {
  AccessCodesOverviewQueryDto,
  CreateAccessCodeDto,
  UpdateAccessCodeDto,
} = require('../dist/access-codes/access-codes.dto');

test('generates exactly four digits, keeps leading zero and skips trivial codes', () => {
  const draws = [1234, 7];
  const code = generateFourDigitCode(() => draws.shift());

  assert.equal(code, '0007');
  assert.equal(isAllowedFourDigitCode(code), true);
  assert.equal(isAllowedFourDigitCode('1234'), false);
  assert.equal(isAllowedFourDigitCode('12345'), false);
});

test('encrypts access codes with authenticated encryption and creates a stable fingerprint', () => {
  const key = Buffer.alloc(32, 17).toString('base64');
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key }),
  );

  const first = cryptoService.encrypt('0427');
  const second = cryptoService.encrypt('0427');

  assert.notEqual(first, second);
  assert.equal(first.includes('0427'), false);
  assert.equal(cryptoService.decrypt(first), '0427');
  assert.equal(cryptoService.fingerprint('0427'), cryptoService.fingerprint('0427'));
  assert.notEqual(cryptoService.fingerprint('0427'), cryptoService.fingerprint('0428'));
});

test('round-trips an opaque history cursor and rejects malformed cursors', () => {
  const source = {
    validFrom: '2026-08-20T12:00:00.000Z',
    id: '123e4567-e89b-42d3-a456-426614174000',
  };
  assert.deepEqual(decodeAccessCodeCursor(encodeAccessCodeCursor(source)), source);
  assert.throws(() => decodeAccessCodeCursor('not-a-cursor'));
});

test('builds default access windows in Europe/Warsaw across summer and winter time', () => {
  const summer = buildAccessCodeValidity({
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    checkInTime: '15:00',
    checkOutTime: '11:00',
    timeZone: 'Europe/Warsaw',
  });
  const winter = buildAccessCodeValidity({
    startDate: '2026-01-10',
    endDate: '2026-01-12',
    checkInTime: '15:00',
    checkOutTime: '11:00',
    timeZone: 'Europe/Warsaw',
  });

  assert.equal(summer.validFrom.toISOString(), '2026-08-20T13:00:00.000Z');
  assert.equal(summer.validUntil.toISOString(), '2026-08-23T09:00:00.000Z');
  assert.equal(winter.validFrom.toISOString(), '2026-01-10T14:00:00.000Z');
  assert.equal(winter.validUntil.toISOString(), '2026-01-12T10:00:00.000Z');
  assert.equal(formatDateInTimeZone(summer.validFrom, 'Europe/Warsaw'), '2026-08-20');
});

test('validates creation and optimistic updates without accepting a caller-provided code', async () => {
  const creation = plainToInstance(CreateAccessCodeDto, {
    reservationId: '123e4567-e89b-42d3-a456-426614174000',
    validFrom: '2026-08-20T14:00:00+02:00',
    validUntil: '2026-08-23T10:00:00+02:00',
  });
  const update = plainToInstance(UpdateAccessCodeDto, {
    validUntil: '2026-08-23T12:00:00+02:00',
    expectedVersion: 2,
  });

  assert.equal((await validate(creation)).length, 0);
  assert.equal('code' in creation, false);
  assert.equal((await validate(update)).length, 0);
});

test('validates optional overview statistics and limits the range to 180 days', async () => {
  const enabled = plainToInstance(AccessCodesOverviewQueryDto, {
    includeStatistics: 'true',
    statisticsDays: '90',
  });
  const tooLong = plainToInstance(AccessCodesOverviewQueryDto, {
    includeStatistics: 'true',
    statisticsDays: '181',
  });

  assert.equal((await validate(enabled)).length, 0);
  assert.equal(enabled.includeStatistics, true);
  assert.equal(enabled.statisticsDays, 90);
  assert.deepEqual((await validate(tooLong)).map((error) => error.property), [
    'statisticsDays',
  ]);
});

test('creates a persistent draft visible to iOS without enabling or calling TTLock writes', async () => {
  const key = Buffer.alloc(32, 23).toString('base64');
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key }),
  );
  let draftCiphertext;
  let readChecks = 0;
  let writeCalls = 0;
  const pool = {
    query: async (sql, values = []) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('FROM reservations AS reservation')) {
        return {
          rows: [
            {
              reservation_id: '123e4567-e89b-42d3-a456-426614174000',
              apartment_id: '223e4567-e89b-42d3-a456-426614174000',
              guest_name: 'Jan Kowalski',
              start_date: '2026-08-20',
              end_date: '2026-08-23',
              status: 'confirmed',
              apartment_name: 'Apartament Rynek',
              access_code_check_in_time: '15:00:00',
              access_code_check_out_time: '11:00:00',
              access_code_time_zone: 'Europe/Warsaw',
              access_device_id: '323e4567-e89b-42d3-a456-426614174000',
              provider_device_id: 123,
            },
          ],
        };
      }
      if (normalized.startsWith('UPDATE access_code_drafts')) return { rows: [] };
      if (normalized.startsWith('INSERT INTO access_code_drafts')) {
        draftCiphertext = values[3];
        return { rows: [{ id: '423e4567-e89b-42d3-a456-426614174000' }] };
      }
      if (normalized.includes('SELECT draft.*')) {
        return {
          rows: [
            {
              id: '423e4567-e89b-42d3-a456-426614174000',
              action: 'create',
              access_code_id: null,
              applied_access_code_id: null,
              reservation_id: '123e4567-e89b-42d3-a456-426614174000',
              apartment_id: '223e4567-e89b-42d3-a456-426614174000',
              apartment_name: 'Apartament Rynek',
              access_device_id: '323e4567-e89b-42d3-a456-426614174000',
              provider_device_id: 123,
              access_device_display_name: 'Zamek Apartament Rynek',
              guest_name: 'Jan Kowalski',
              code_ciphertext: draftCiphertext,
              code_name: 'Jan Kowalski / 2026-08-20',
              valid_from: '2026-08-20T12:00:00.000Z',
              valid_until: '2026-08-23T08:00:00.000Z',
              display_status: 'draft',
              expires_at: '2026-08-13T13:30:00.000Z',
              last_error: null,
              version: 1,
              created_at: '2026-08-13T13:00:00.000Z',
              updated_at: '2026-08-13T13:00:00.000Z',
            },
          ],
        };
      }
      if (
        normalized.includes('FROM reservation_access_codes') ||
        normalized.includes('FROM access_code_drafts')
      ) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${normalized}`);
    },
  };
  const ttlock = {
    isPasscodeAvailable: async () => {
      readChecks += 1;
      return true;
    },
    assertWritesAllowed: () => {
      writeCalls += 1;
    },
    createPasscode: async () => {
      writeCalls += 1;
      return { keyboardPwdId: 1 };
    },
  };
  const service = new AccessCodesService(
    pool,
    ttlock,
    cryptoService,
    new ConfigService({ ACCESS_CODE_DRAFT_TTL_MINUTES: '30' }),
  );

  const draft = await service.createDraft(
    {
      reservationId: '123e4567-e89b-42d3-a456-426614174000',
      validFrom: '2026-08-20T14:00:00+02:00',
      validUntil: '2026-08-23T10:00:00+02:00',
    },
    { id: 'owner', email: 'owner@example.com' },
  );

  assert.match(draft.code, /^\d{4}$/);
  assert.equal(draft.status, 'draft');
  assert.deepEqual(draft.accessDevice, {
    id: '323e4567-e89b-42d3-a456-426614174000',
    provider: 'ttlock',
    lockId: 123,
    displayName: 'Zamek Apartament Rynek',
  });
  assert.equal(readChecks, 1);
  assert.equal(writeCalls, 0);
});

test('automatically creates and confirms one idempotent code from apartment defaults', async () => {
  const key = Buffer.alloc(32, 41).toString('base64');
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key }),
  );
  const reservationId = '123e4567-e89b-42d3-a456-426614174000';
  const apartmentId = '223e4567-e89b-42d3-a456-426614174000';
  const deviceId = '323e4567-e89b-42d3-a456-426614174000';
  const accessCodeId = '423e4567-e89b-42d3-a456-426614174000';
  let codeCiphertext;
  let metadata;
  let providerPasscodeId = null;
  let currentCodeExists = false;
  let createCalls = 0;
  let writeChecks = 0;
  let providerParams;

  const accessCodeRow = () => ({
    id: accessCodeId,
    reservation_id: reservationId,
    apartment_id: apartmentId,
    apartment_name: 'Apartament Rynek',
    access_device_id: deviceId,
    provider_device_id: 123,
    access_device_display_name: 'Zamek Rynek',
    guest_name: 'Jan Kowalski',
    stay_start_date: '2026-08-20',
    stay_end_date: '2026-08-23',
    code_ciphertext: codeCiphertext,
    code_name: 'Jan Kowalski / 2026-08-20',
    valid_from: '2026-08-20T13:00:00.000Z',
    valid_until: '2026-08-23T09:00:00.000Z',
    metadata,
    display_status: 'active',
    provider_passcode_id: providerPasscodeId,
    usage_count: null,
    first_used_at: null,
    last_used_at: null,
    usage_synced_at: null,
    last_error: null,
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T10:00:00.000Z',
    version: 1,
  });

  const pool = {
    query: async (sql, values = []) => {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      if (normalized.includes('FROM reservations AS reservation')) {
        return {
          rows: [{
            reservation_id: reservationId,
            apartment_id: apartmentId,
            guest_name: 'Jan Kowalski',
            start_date: '2026-08-20',
            end_date: '2026-08-23',
            status: 'confirmed',
            apartment_name: 'Apartament Rynek',
            access_code_check_in_time: '15:00:00',
            access_code_check_out_time: '11:00:00',
            access_code_time_zone: 'Europe/Warsaw',
            access_device_id: deviceId,
            provider_device_id: 123,
          }],
        };
      }
      if (normalized.startsWith('SELECT id, status FROM reservation_access_codes')) {
        return { rows: currentCodeExists ? [{ id: accessCodeId, status: 'active' }] : [] };
      }
      if (normalized.includes('code_fingerprint') || normalized.includes('FROM access_code_drafts')) {
        return { rows: [] };
      }
      if (normalized.startsWith('UPDATE reservation_access_codes SET provider_passcode_id')) {
        providerPasscodeId = Number(values[1]);
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE reservation_access_codes SET status = 'active'")) {
        currentCodeExists = true;
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO access_code_audit_events')) return { rows: [] };
      if (normalized.includes('SELECT code.*')) return { rows: [accessCodeRow()] };
      throw new Error(`unexpected query: ${normalized}`);
    },
    connect: async () => ({
      query: async (sql, values = []) => {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [] };
        if (normalized.startsWith('SELECT id FROM apartment_access_devices')) return { rows: [] };
        if (normalized.includes('SELECT 1 FROM reservation_access_codes')) return { rows: [] };
        if (normalized.startsWith('INSERT INTO reservation_access_codes')) {
          codeCiphertext = values[3];
          metadata = JSON.parse(values[8]);
          return { rows: [{ id: accessCodeId }] };
        }
        throw new Error(`unexpected transaction query: ${normalized}`);
      },
      release: () => undefined,
    }),
  };
  const ttlock = {
    assertWritesAllowed: () => {
      writeChecks += 1;
    },
    isPasscodeAvailable: async () => true,
    createPasscode: async (params) => {
      createCalls += 1;
      providerParams = params;
      return { keyboardPwdId: 987 };
    },
    isPasscodeConfigured: async (params) => {
      assert.equal(params.keyboardPwdId, 987);
      assert.equal(params.passcode, providerParams.passcode);
      return true;
    },
  };
  const service = new AccessCodesService(pool, ttlock, cryptoService, new ConfigService({}));
  const actor = { id: 'owner', email: 'owner@example.com' };

  const created = await service.ensureForReservation(reservationId, actor);
  const repeated = await service.ensureForReservation(reservationId, actor);

  assert.equal(created.id, accessCodeId);
  assert.equal(repeated.id, accessCodeId);
  assert.equal(created.validitySource, 'apartment_default');
  assert.equal(created.timeZone, 'Europe/Warsaw');
  assert.equal(created.validFrom, '2026-08-20T13:00:00.000Z');
  assert.equal(created.validUntil, '2026-08-23T09:00:00.000Z');
  assert.equal(providerParams.startAt.toISOString(), created.validFrom);
  assert.equal(providerParams.endAt.toISOString(), created.validUntil);
  assert.equal(createCalls, 1);
  assert.equal(writeChecks, 1);
});

test('builds a lock overview from safe TTLock data and local apartment mappings', async () => {
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString('base64') }),
  );
  const pool = {
    query: async () => ({
      rows: [
        {
          access_device_id: '323e4567-e89b-42d3-a456-426614174000',
          provider_device_id: 123,
          display_name: 'Zamek Rynek',
          scope: 'apartment',
          apartment_id: '223e4567-e89b-42d3-a456-426614174000',
          apartment_name: 'Apartament Rynek',
          current_code_count: '1',
          upcoming_code_count: '2',
          sync_error_count: '0',
        },
      ],
    }),
  };
  const ttlock = {
    listLocks: async () => [
      {
        lockId: 123,
        name: 'S31',
        alias: 'Rynek',
        batteryPercentage: 18,
        hasGateway: true,
        keyboardPwdVersion: 4,
      },
    ],
    listGateways: async () => [{ gatewayId: 1, online: true }],
    getLockStatistics: async () => ({
      recordsScanned: 12,
      successfulUnlocks: 10,
      successfulPasscodeUnlocks: 8,
      invalidPasscodeAttempts: 1,
      lastActivityAt: '2026-08-13T12:00:00.000Z',
      complete: true,
    }),
  };
  const service = new AccessCodesService(
    pool,
    ttlock,
    cryptoService,
    new ConfigService({}),
  );

  const overview = await service.getOverview({
    includeStatistics: true,
    statisticsDays: 30,
  });

  assert.equal(overview.gateways.online, 1);
  assert.equal(overview.statisticsRange.providerRetentionGuaranteed, false);
  assert.equal(overview.locks[0].batteryLevel, 'critical');
  assert.equal(overview.locks[0].mapping.apartmentName, 'Apartament Rynek');
  assert.deepEqual(overview.locks[0].codeCounts, {
    current: 1,
    upcoming: 2,
    syncErrors: 0,
  });
  assert.equal(overview.locks[0].statistics.successfulPasscodeUnlocks, 8);
});
