const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { ConfigService } = require('@nestjs/config');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const {
  sanitizeGatewayList,
  sanitizeLockList,
  sanitizePasscodeList,
} = require('../dist/ttlock/ttlock.domain');
const {
  CreateDiagnosticTtlockPasscodeDto,
  PreviewTtlockPasscodeDto,
  UpdateDiagnosticTtlockPasscodeDto,
} = require('../dist/ttlock/ttlock.dto');
const { TtlockController } = require('../dist/ttlock/ttlock.controller');
const { TtlockService } = require('../dist/ttlock/ttlock.service');

test('removes sensitive TTLock lock and gateway fields from public responses', () => {
  const locks = sanitizeLockList({
    list: [
      {
        lockId: 12,
        lockName: 'Rynek',
        lockAlias: 'Apartament Rynek',
        lockMac: 'secret-mac',
        lockData: 'secret-lock-data',
        aesKeyStr: 'secret-aes',
        adminPwd: 'secret-admin-code',
        electricQuantity: 87,
        keyboardPwdVersion: 4,
        specialValue: 1288,
        hasGateway: 1,
      },
    ],
  });
  const gateways = sanitizeGatewayList({
    list: [
      {
        gatewayId: 34,
        gatewayMac: 'secret-gateway-mac',
        networkName: 'private-wifi-name',
        gatewayVersion: 2,
        lockNum: 1,
        isOnline: 1,
      },
    ],
  });

  assert.deepEqual(locks, [
    {
      lockId: 12,
      name: 'Rynek',
      alias: 'Apartament Rynek',
      initializedAt: null,
      batteryPercentage: 87,
      keyboardPwdVersion: 4,
      specialValue: 1288,
      hasGateway: true,
      groupId: null,
      groupName: null,
    },
  ]);
  assert.deepEqual(gateways, [
    { gatewayId: 34, version: 2, lockCount: 1, online: true },
  ]);
  assert.equal('lockData' in locks[0], false);
  assert.equal('lockMac' in locks[0], false);
  assert.equal('gatewayMac' in gateways[0], false);
  assert.equal('networkName' in gateways[0], false);
});

test('removes passcode values while preserving safe TTLock metadata', () => {
  const passcodes = sanitizePasscodeList({
    list: [
      {
        keyboardPwdId: 98,
        lockId: 12,
        keyboardPwd: '123456',
        keyboardPwdName: 'Rezerwacja testowa',
        keyboardPwdVersion: 4,
        keyboardPwdType: 3,
        startDate: 1000,
        endDate: 2000,
        sendDate: 900,
        isCustom: 1,
        status: 1,
        senderUsername: 'private-account',
      },
    ],
  });

  assert.deepEqual(passcodes, [
    {
      keyboardPwdId: 98,
      lockId: 12,
      name: 'Rezerwacja testowa',
      codeLength: 6,
      type: 3,
      startAt: 1000,
      endAt: 2000,
      createdAt: 900,
      custom: true,
      status: 1,
    },
  ]);
  assert.equal('keyboardPwd' in passcodes[0], false);
  assert.equal('senderUsername' in passcodes[0], false);
});

test('accepts exactly four digits and preserves a leading zero', async () => {
  const fourDigits = plainToInstance(PreviewTtlockPasscodeDto, {
    lockId: 12,
    passcode: '0123',
    startAt: '2026-08-20T14:00:00+02:00',
    endAt: '2026-08-23T10:00:00+02:00',
  });
  const threeDigits = plainToInstance(PreviewTtlockPasscodeDto, {
    lockId: 12,
    passcode: '123',
    startAt: '2026-08-20T14:00:00+02:00',
    endAt: '2026-08-23T10:00:00+02:00',
  });
  const fiveDigits = plainToInstance(PreviewTtlockPasscodeDto, {
    lockId: 12,
    passcode: '12345',
    startAt: '2026-08-20T14:00:00+02:00',
    endAt: '2026-08-23T10:00:00+02:00',
  });

  assert.equal((await validate(fourDigits)).length, 0);
  assert.deepEqual((await validate(threeDigits)).map((error) => error.property), ['passcode']);
  assert.deepEqual((await validate(fiveDigits)).map((error) => error.property), ['passcode']);
});

test('validates diagnostic create and update payloads without a reservation', async () => {
  const creation = plainToInstance(CreateDiagnosticTtlockPasscodeDto, {
    passcode: '4827',
    name: 'TEST API',
    startAt: '2026-09-20T15:00:00+02:00',
    endAt: '2026-09-23T11:00:00+02:00',
  });
  const update = plainToInstance(UpdateDiagnosticTtlockPasscodeDto, {
    startAt: '2026-09-21T15:00:00+02:00',
    endAt: '2026-09-24T11:00:00+02:00',
  });

  assert.equal((await validate(creation)).length, 0);
  assert.equal((await validate(update)).length, 0);
  assert.equal('reservationId' in creation, false);
});

test('runs diagnostic create, update and delete directly through TTLock', async () => {
  const calls = [];
  const ttlock = {
    previewPasscode: async (params) => {
      calls.push(['preview', params]);
      return { valid: true, writeExecuted: false };
    },
    createPasscode: async (params) => {
      calls.push(['create', params]);
      return { keyboardPwdId: 987 };
    },
    changePasscode: async (params) => {
      calls.push(['update', params]);
    },
    deletePasscode: async (...params) => {
      calls.push(['delete', params]);
    },
  };
  const controller = new TtlockController(ttlock);

  const created = await controller.createDiagnosticPasscode(123, {
    passcode: '4827',
    name: 'TEST API',
    startAt: '2026-09-20T15:00:00+02:00',
    endAt: '2026-09-23T11:00:00+02:00',
  });
  const updated = await controller.updateDiagnosticPasscode(123, 987, {
    startAt: '2026-09-21T15:00:00+02:00',
    endAt: '2026-09-24T11:00:00+02:00',
  });
  const deleted = await controller.deleteDiagnosticPasscode(123, 987);

  assert.equal(created.keyboardPwdId, 987);
  assert.equal(created.databaseWriteExecuted, false);
  assert.equal(updated.action, 'updated');
  assert.equal(deleted.action, 'deleted');
  assert.deepEqual(calls.map(([action]) => action), [
    'preview',
    'create',
    'update',
    'delete',
  ]);
});

test('previews a gateway passcode without calling the TTLock write endpoint', async () => {
  const originalFetch = global.fetch;
  const paths = [];

  global.fetch = async (url) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(
      JSON.stringify({
        list: [
          {
            lockId: 123,
            lockName: 'S31_test',
            lockAlias: 'Apartament testowy',
            keyboardPwdVersion: 4,
            hasGateway: 1,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );

    const preview = await service.previewPasscode({
      lockId: 123,
      passcode: '0123',
      name: 'Test bez zapisu',
      startAt: '2026-08-20T14:00:00+02:00',
      endAt: '2026-08-23T10:00:00+02:00',
    });

    assert.equal(preview.valid, true);
    assert.equal(preview.writeExecuted, false);
    assert.equal(preview.passcodeLength, 4);
    assert.equal('passcode' in preview, false);
    assert.deepEqual(paths, ['/v3/lock/list']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('blocks every TTLock write before making a network request by default', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('network must not be called');
  };

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );

    await assert.rejects(
      service.createPasscode({
        lockId: 123,
        passcode: '4827',
        name: 'Test',
        startAt: new Date('2026-08-20T12:00:00.000Z'),
        endAt: new Date('2026-08-23T08:00:00.000Z'),
      }),
      /Zapisy TTLock są zablokowane/,
    );
    assert.equal(called, false);
    assert.equal(service.getStatus().mode, 'read_only');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uses gateway mode for mocked create, change and delete operations', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    const body = new URLSearchParams(options.body);
    requests.push({ path, body });
    return new Response(
      JSON.stringify(path.endsWith('/add') ? { keyboardPwdId: 987 } : { errcode: 0 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_WRITES_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );
    const startAt = new Date('2026-08-20T12:00:00.000Z');
    const endAt = new Date('2026-08-23T08:00:00.000Z');

    assert.deepEqual(
      await service.createPasscode({ lockId: 123, passcode: '4827', name: 'Gość', startAt, endAt }),
      { keyboardPwdId: 987 },
    );
    await service.changePasscode({
      lockId: 123,
      keyboardPwdId: 987,
      newPasscode: '5928',
      startAt,
      endAt,
    });
    await service.deletePasscode(123, 987);

    assert.deepEqual(
      requests.map((request) => request.path),
      ['/v3/keyboardPwd/add', '/v3/keyboardPwd/change', '/v3/keyboardPwd/delete'],
    );
    assert.equal(requests[0].body.get('keyboardPwd'), '4827');
    assert.equal(requests[0].body.get('addType'), '2');
    assert.equal(requests[1].body.get('newKeyboardPwd'), '5928');
    assert.equal(requests[1].body.get('changeType'), '2');
    assert.equal(requests[2].body.get('deleteType'), '2');
    assert.equal(service.getStatus().mode, 'read_write');
  } finally {
    global.fetch = originalFetch;
  }
});

test('confirms a created code by provider id, value and validity window', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        list: [{
          lockId: 123,
          keyboardPwdId: 987,
          keyboardPwd: '4827',
          startDate: 1787230800000,
          endDate: 1787475600000,
        }],
        pages: 1,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );
    const configured = await service.isPasscodeConfigured({
      lockId: 123,
      keyboardPwdId: 987,
      passcode: '4827',
      startAt: new Date(1787230800000),
      endAt: new Date(1787475600000),
    });

    assert.equal(configured, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('counts successful passcode unlock records on demand without returning raw codes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        pageNo: 1,
        pages: 1,
        list: [
          {
            recordType: 4,
            success: 1,
            keyboardPwd: '4827',
            username: 'private-account',
            lockDate: 1787220000000,
            serverDate: 1787220001000,
          },
          {
            recordType: 4,
            success: 0,
            keyboardPwd: '4827',
            lockDate: 1787220100000,
          },
          {
            recordType: 4,
            success: 1,
            keyboardPwd: '1111',
            lockDate: 1787220200000,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );
    const usage = await service.getPasscodeUsage({
      lockId: 123,
      passcode: '4827',
      startAt: new Date('2026-08-20T00:00:00.000Z'),
      endAt: new Date('2026-08-24T00:00:00.000Z'),
    });

    assert.equal(usage.usageCount, 1);
    assert.equal(usage.events.length, 1);
    assert.equal('keyboardPwd' in usage.events[0], false);
    assert.equal('username' in usage.events[0], false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('aggregates safe lock statistics without returning raw TTLock records', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        pageNo: 1,
        pages: 1,
        list: [
          { recordType: 4, success: 1, keyboardPwd: '4827', lockDate: 1787220000000 },
          { recordType: 7, success: 1, username: 'private', lockDate: 1787220100000 },
          { recordType: 48, success: 0, keyboardPwd: '9999', lockDate: 1787220200000 },
          { recordType: 4, success: 0, keyboardPwd: '1111', lockDate: 1787220300000 },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'access-token',
      }),
    );
    const statistics = await service.getLockStatistics({
      lockId: 123,
      startAt: new Date('2026-08-01T00:00:00.000Z'),
      endAt: new Date('2026-08-14T00:00:00.000Z'),
    });

    assert.deepEqual(statistics, {
      recordsScanned: 4,
      successfulUnlocks: 2,
      successfulPasscodeUnlocks: 1,
      invalidPasscodeAttempts: 1,
      lastActivityAt: new Date(1787220300000).toISOString(),
      complete: true,
    });
    assert.equal('records' in statistics, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('authenticates once, reuses the token and only returns safe lock data', async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options) => {
    const body = new URLSearchParams(options.body);
    requests.push({ url: String(url), body });

    if (String(url).endsWith('/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 7776000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        list: [
          {
            lockId: 123,
            lockName: 'Góry',
            lockData: 'must-never-leave-the-service',
            lockMac: 'must-also-stay-private',
            electricQuantity: 91,
            keyboardPwdVersion: 4,
            hasGateway: 1,
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCOUNT_USERNAME: 'owner-account',
        TTLOCK_ACCOUNT_PASSWORD_MD5: '0123456789abcdef0123456789abcdef',
      }),
    );

    const first = await service.listLocks();
    const second = await service.listLocks();

    assert.equal(requests.filter((request) => request.url.endsWith('/oauth2/token')).length, 1);
    assert.equal(requests.filter((request) => request.url.endsWith('/v3/lock/list')).length, 2);
    assert.equal(requests[0].body.get('password'), '0123456789abcdef0123456789abcdef');
    assert.deepEqual(first, second);
    assert.equal(first[0].lockId, 123);
    assert.equal(first[0].keyboardPwdVersion, 4);
    assert.equal('lockData' in first[0], false);
    assert.equal('lockMac' in first[0], false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('refreshes a rejected access token once and retries the read-only request', async () => {
  const originalFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options) => {
    const body = new URLSearchParams(options.body);
    requests.push({ url: String(url), body });

    if (String(url).endsWith('/oauth2/token')) {
      return new Response(
        JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 7776000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (body.get('accessToken') === 'expired-access-token') {
      return new Response(JSON.stringify({ errcode: 10004 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ list: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const service = new TtlockService(
      new ConfigService({
        TTLOCK_ENABLED: 'true',
        TTLOCK_CLIENT_ID: 'client-id',
        TTLOCK_CLIENT_SECRET: 'client-secret',
        TTLOCK_ACCESS_TOKEN: 'expired-access-token',
        TTLOCK_REFRESH_TOKEN: 'refresh-token',
      }),
    );

    assert.deepEqual(await service.listLocks(), []);
    const oauthRequests = requests.filter((request) => request.url.endsWith('/oauth2/token'));
    const lockRequests = requests.filter((request) => request.url.endsWith('/v3/lock/list'));

    assert.equal(oauthRequests.length, 1);
    assert.equal(oauthRequests[0].body.get('grant_type'), 'refresh_token');
    assert.equal(oauthRequests[0].body.get('refresh_token'), 'refresh-token');
    assert.equal(lockRequests.length, 2);
    assert.equal(lockRequests[1].body.get('accessToken'), 'new-access-token');
  } finally {
    global.fetch = originalFetch;
  }
});
