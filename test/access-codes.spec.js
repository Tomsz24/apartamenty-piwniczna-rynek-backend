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
  manualAccessCodeWindowError,
  shouldApplyDefaultValidity,
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

test('uses the agreed 12:00 arrival and 11:00 departure access window year round', () => {
  const summer = buildAccessCodeValidity({
    startDate: '2026-08-20',
    endDate: '2026-08-23',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    timeZone: 'Europe/Warsaw',
  });
  const winter = buildAccessCodeValidity({
    startDate: '2026-01-10',
    endDate: '2026-01-12',
    checkInTime: '12:00',
    checkOutTime: '11:00',
    timeZone: 'Europe/Warsaw',
  });

  assert.equal(summer.validFrom.toISOString(), '2026-08-20T10:00:00.000Z');
  assert.equal(summer.validUntil.toISOString(), '2026-08-23T09:00:00.000Z');
  assert.equal(winter.validFrom.toISOString(), '2026-01-10T11:00:00.000Z');
  assert.equal(winter.validUntil.toISOString(), '2026-01-12T10:00:00.000Z');
});

test('runs automatic access-code lifecycle only when explicitly enabled and TTLock writes are enabled', async () => {
  const key = Buffer.alloc(32, 31).toString('base64');
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key }),
  );
  const events = [];
  const service = new AccessCodesService(
    { query: async () => ({ rows: [] }) },
    { getStatus: () => ({ writesEnabled: true }) },
    cryptoService,
    new ConfigService({ ACCESS_CODE_AUTOMATION_ENABLED: 'true' }),
  );
  service.recoverStuckCodes = async () => events.push('recovered');
  service.reconcileCancelledReservations = async () => events.push('cancelled');
  service.reconcileChangedReservationDates = async () => events.push('updated');
  service.createDueReservationCodes = async () => events.push('created');

  await service.handleScheduledLifecycle();
  assert.deepEqual(events, ['recovered', 'cancelled', 'updated', 'created']);

  const disabledService = new AccessCodesService(
    { query: async () => ({ rows: [] }) },
    { getStatus: () => ({ writesEnabled: true }) },
    cryptoService,
    new ConfigService({ ACCESS_CODE_AUTOMATION_ENABLED: 'false' }),
  );
  disabledService.recoverStuckCodes = async () => events.push('unexpected');
  disabledService.reconcileCancelledReservations = async () => events.push('unexpected');
  await disabledService.handleScheduledLifecycle();
  assert.equal(events.includes('unexpected'), false);
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

test('manual code windows may move days and hours but stay within a day of the stay', () => {
  const stay = { stayStartDate: '2026-10-22', stayEndDate: '2026-10-24', timeZone: 'Europe/Warsaw' };
  const at = (value) => new Date(value);
  assert.equal(manualAccessCodeWindowError({
    ...stay, startAt: at('2026-10-21T18:00:00+02:00'), endAt: at('2026-10-25T09:00:00+02:00'),
  }), null);
  assert.equal(manualAccessCodeWindowError({
    ...stay, startAt: at('2026-10-22T09:00:00+02:00'), endAt: at('2026-10-23T11:00:00+02:00'),
  }), null);
  assert.match(manualAccessCodeWindowError({
    ...stay, startAt: at('2026-10-20T12:00:00+02:00'), endAt: at('2026-10-24T11:00:00+02:00'),
  }), /dzień przed przyjazdem/);
  assert.match(manualAccessCodeWindowError({
    ...stay, startAt: at('2026-10-22T12:00:00+02:00'), endAt: at('2026-11-24T11:00:00+01:00'),
  }), /dzień po wyjeździe/);
  // 23:30 UTC is already the next day in Warsaw.
  assert.match(manualAccessCodeWindowError({
    ...stay, startAt: at('2026-10-20T23:30:00Z'), endAt: at('2026-10-24T09:00:00Z'),
  }) ?? '', /^$/);
});

test('keeps manual windows for the same stay and resets them once the stay moves', () => {
  const manual = {
    validitySource: 'manual_override',
    overrideStayStartDate: '2026-10-22',
    overrideStayEndDate: '2026-10-24',
  };
  assert.equal(shouldApplyDefaultValidity({ metadata: manual, stayStartDate: '2026-10-22', stayEndDate: '2026-10-24' }), false);
  assert.equal(shouldApplyDefaultValidity({ metadata: manual, stayStartDate: '2026-10-22', stayEndDate: '2026-10-26' }), true);
  assert.equal(shouldApplyDefaultValidity({ metadata: { validitySource: 'apartment_default' }, stayStartDate: '2026-10-22', stayEndDate: '2026-10-24' }), true);
  assert.equal(shouldApplyDefaultValidity({ metadata: null, stayStartDate: '2026-10-22', stayEndDate: '2026-10-24' }), true);
});

test('date reconciliation follows extensions mid-stay but leaves manual windows alone', async () => {
  const key = Buffer.alloc(32, 31).toString('base64');
  const queries = [];
  const rows = [
    // Default code, stay extended from 24th to 26th while the guest is already there.
    { id: 'default', version: 3, valid_from: '2026-10-22T10:00:00.000Z', valid_until: '2026-10-24T09:00:00.000Z',
      metadata: { validitySource: 'apartment_default' }, start_date: '2026-10-22', end_date: '2026-10-26',
      access_code_check_in_time: '12:00:00', access_code_check_out_time: '11:00:00', access_code_time_zone: 'Europe/Warsaw' },
    // Manual early check-in for the unchanged stay: must survive.
    { id: 'manual-same', version: 5, valid_from: '2026-10-22T07:00:00.000Z', valid_until: '2026-10-24T09:00:00.000Z',
      metadata: { validitySource: 'manual_override', overrideStayStartDate: '2026-10-22', overrideStayEndDate: '2026-10-24' },
      start_date: '2026-10-22', end_date: '2026-10-24',
      access_code_check_in_time: '12:00:00', access_code_check_out_time: '11:00:00', access_code_time_zone: 'Europe/Warsaw' },
    // Manual window, then the stay was shortened: back to the default for the new dates.
    { id: 'manual-moved', version: 2, valid_from: '2026-10-22T07:00:00.000Z', valid_until: '2026-10-24T09:00:00.000Z',
      metadata: { validitySource: 'manual_override', overrideStayStartDate: '2026-10-22', overrideStayEndDate: '2026-10-24' },
      start_date: '2026-10-22', end_date: '2026-10-23',
      access_code_check_in_time: '12:00:00', access_code_check_out_time: '11:00:00', access_code_time_zone: 'Europe/Warsaw' },
  ];
  const service = new AccessCodesService(
    { query: async (text) => { queries.push(text); return { rows }; } },
    { getStatus: () => ({ writesEnabled: true }) },
    new AccessCodeCryptoService(new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key })),
    new ConfigService({}),
  );
  const updates = [];
  service.updateWithValiditySource = async (id, dto, actor, source) => updates.push({ id, ...dto, source });

  await service.reconcileChangedReservationDates();

  assert.match(queries[0], /code\.valid_until > NOW\(\)/);
  assert.doesNotMatch(queries[0], /<= reservation\.start_date/);
  assert.deepEqual(updates, [
    { id: 'default', validFrom: '2026-10-22T10:00:00.000Z', validUntil: '2026-10-26T10:00:00.000Z', expectedVersion: 3, source: 'apartment_default' },
    { id: 'manual-moved', validFrom: '2026-10-22T10:00:00.000Z', validUntil: '2026-10-23T09:00:00.000Z', expectedVersion: 2, source: 'apartment_default' },
  ]);
});

function recoveryHarness(row, ttlockOverrides = {}) {
  const key = Buffer.alloc(32, 31).toString('base64');
  const cryptoService = new AccessCodeCryptoService(
    new ConfigService({ ACCESS_CODE_ENCRYPTION_KEY: key }),
  );
  const fullRow = {
    id: 'code-1',
    version: 4,
    status: 'sync_error',
    provider_device_id: '77',
    provider_passcode_id: null,
    reservation_status: 'confirmed',
    code_ciphertext: cryptoService.encrypt('4821'),
    code_name: 'Anna',
    valid_from: new Date(Date.now() + 3600_000).toISOString(),
    valid_until: new Date(Date.now() + 3 * 86400_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...row,
  };
  const statuses = [];
  const calls = [];
  const pool = {
    query: async (text, params = []) => {
      if (/JOIN apartment_access_devices AS device ON device\.id = code\.access_device_id/.test(text)) {
        return { rows: [fullRow] };
      }
      if (/SET status = \$3, version = version \+ 1/.test(text)) {
        statuses.push(params[2]);
        return { rows: [{ version: fullRow.version + 1 }] };
      }
      const status = text.match(/SET status = '(\w+)'/);
      if (status) statuses.push(status[1]);
      return { rows: [] };
    },
  };
  const ttlock = {
    getStatus: () => ({ writesEnabled: true }),
    assertWritesAllowed: () => {},
    findPasscode: async () => null,
    passcodeExists: async () => true,
    isPasscodeAvailable: async () => true,
    isPasscodeConfigured: async () => true,
    createPasscode: async () => {
      calls.push('create');
      return { keyboardPwdId: 555 };
    },
    changePasscode: async () => calls.push('change'),
    deletePasscode: async () => calls.push('delete'),
    ...ttlockOverrides,
  };
  const service = new AccessCodesService(pool, ttlock, cryptoService, new ConfigService({}));
  service.getById = async (id) => ({ id });
  return { service, statuses, calls };
}

const recoveryActor = { id: 'admin', email: 'admin@example.com' };

test('recovery adopts a code that reached the lock even though the create call failed', async () => {
  const { service, statuses, calls } = recoveryHarness({}, { findPasscode: async () => 901 });
  await service.reconcile('code-1', recoveryActor);
  assert.deepEqual(calls, []);
  assert.deepEqual(statuses, ['pending_create', 'active']);
});

test('recovery recreates a code that never reached the lock', async () => {
  const { service, statuses, calls } = recoveryHarness();
  await service.reconcile('code-1', recoveryActor);
  assert.deepEqual(calls, ['create']);
  assert.deepEqual(statuses, ['pending_create', 'active']);
});

test('deleting a code without a TTLock id checks the lock instead of blocking', async () => {
  const { service, statuses, calls } = recoveryHarness();
  await service.revoke('code-1', 4, recoveryActor);
  assert.deepEqual(calls, []);
  assert.deepEqual(statuses, ['pending_delete', 'revoked']);
});

test('recovery leaves a code that is still being written alone', async () => {
  const { service, calls } = recoveryHarness({ status: 'pending_create' });
  await assert.rejects(service.reconcile('code-1', recoveryActor), /w toku/);
  assert.deepEqual(calls, []);
});

test('recovering a delete whose answer got lost confirms the code is gone instead of retrying', async () => {
  const { service, statuses, calls } = recoveryHarness(
    { provider_passcode_id: '901', reservation_status: 'cancelled' },
    {
      passcodeExists: async () => false,
      deletePasscode: async () => { throw new Error('TTLock: passcode does not exist'); },
    },
  );
  await service.reconcile('code-1', recoveryActor);
  assert.deepEqual(calls, []);
  assert.deepEqual(statuses, ['pending_delete', 'revoked']);
});

test('recovering a delete still removes a code that is on the lock', async () => {
  const { service, statuses, calls } = recoveryHarness({ provider_passcode_id: '901', reservation_status: 'cancelled' });
  await service.reconcile('code-1', recoveryActor);
  assert.deepEqual(calls, ['delete']);
  assert.deepEqual(statuses, ['pending_delete', 'revoked']);
});
