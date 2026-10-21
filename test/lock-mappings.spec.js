const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
require('reflect-metadata');

const { LockMappingsService } = require('../dist/access-codes/lock-mappings.service');

const GORY = '00000000-0000-0000-0000-000000000001';
const RYNEK = '00000000-0000-0000-0000-000000000002';
const LOCKS = [
  { lockId: 19051854, alias: 'Apartament z balkonem i widokiem na góry' },
  { lockId: 19051822, alias: 'Apartament z kominkiem i widokiem na Rynek' },
  { lockId: 30000001, alias: 'Nowy zamek' },
];
const actor = { id: 'admin', email: 'admin@example.test' };

// In-memory apartment_access_devices + reservation_access_codes.
function createPool({ devices = [], liveCodes = {} } = {}) {
  const apartments = { [GORY]: 'Apartament - Widok na góry', [RYNEK]: 'Apartament - Widok na rynek' };
  const run = async (text, params = []) => {
    if (text.includes('FROM apartments WHERE id')) {
      return { rows: apartments[params[0]] ? [{ id: params[0], name: apartments[params[0]] }] : [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text) || text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('WHERE apartment_id = $1 AND provider')) {
      return { rows: devices.filter((device) => device.apartment_id === params[0] && device.active) };
    }
    if (text.includes('WHERE provider = \'ttlock\' AND provider_device_id = $1')) {
      return { rows: devices.filter((device) => device.lock_id === params[0]) };
    }
    if (text.includes('FROM reservation_access_codes')) return { rows: [{ count: liveCodes[params[0]] ?? 0 }] };
    if (text.includes('SET active = false')) {
      devices.find((device) => device.id === params[0]).active = false;
      return { rows: [] };
    }
    if (text.includes('UPDATE apartment_access_devices SET')) {
      Object.assign(devices.find((device) => device.id === params[0]), {
        apartment_id: params[1], scope: 'apartment', active: true, display_name: params[2],
      });
      return { rows: [] };
    }
    if (text.includes('INSERT INTO apartment_access_devices')) {
      devices.push({ id: `dev-${devices.length + 1}`, apartment_id: params[0], lock_id: params[1], scope: 'apartment', active: true });
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  return { devices, query: run, connect: async () => ({ query: run, release: () => undefined }) };
}

function service(pool) {
  return new LockMappingsService(pool, { listLocks: async () => LOCKS });
}

test('assigns a lock to an apartment and is a no-op when nothing changes', async () => {
  const pool = createPool();
  const result = await service(pool).setApartmentLock(GORY, 19051854, actor);
  assert.deepEqual(result, {
    lockId: 19051854, alias: LOCKS[0].alias, apartmentId: GORY, apartmentName: 'Apartament - Widok na góry',
  });
  assert.equal(pool.devices.length, 1);
  await service(pool).setApartmentLock(GORY, 19051854, actor);
  assert.equal(pool.devices.length, 1);
});

test('replacing an apartment lock deactivates the previous one', async () => {
  const pool = createPool({ devices: [{ id: 'old', apartment_id: GORY, lock_id: 19051854, scope: 'apartment', active: true }] });
  await service(pool).setApartmentLock(GORY, 30000001, actor);
  assert.equal(pool.devices.find((device) => device.id === 'old').active, false);
  assert.equal(pool.devices.filter((device) => device.active).length, 1);
  assert.equal(pool.devices.find((device) => device.active).lock_id, 30000001);
});

test('refuses to move a lock or replace one that still has guest codes', async () => {
  const devices = [{ id: 'gory', apartment_id: GORY, lock_id: 19051854, scope: 'apartment', active: true }];
  const pool = createPool({ devices, liveCodes: { gory: 1 } });
  await assert.rejects(service(pool).setApartmentLock(RYNEK, 19051854, actor), { status: 409 });
  await assert.rejects(service(pool).setApartmentLock(GORY, 30000001, actor), { status: 409 });
  assert.equal(devices[0].active, true);
  assert.equal(devices[0].apartment_id, GORY);
});

test('rejects unknown locks and apartments', async () => {
  const pool = createPool();
  await assert.rejects(service(pool).setApartmentLock(GORY, 999, actor), { status: 404 });
  await assert.rejects(
    service(pool).setApartmentLock('00000000-0000-0000-0000-000000000009', 19051854, actor),
    { status: 404 },
  );
});

// Optional real PostgreSQL engine test: set PGLITE_MODULE to an installed @electric-sql/pglite.
test('lock mapping migration assigns both apartment locks once and never the entrance', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE apartments(id uuid PRIMARY KEY, name text);
      CREATE TABLE apartment_access_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        apartment_id uuid REFERENCES apartments(id),
        provider text NOT NULL DEFAULT 'ttlock',
        provider_device_id bigint NOT NULL,
        scope text NOT NULL,
        display_name text,
        active boolean NOT NULL DEFAULT true,
        UNIQUE (provider, provider_device_id));
      CREATE UNIQUE INDEX one_active ON apartment_access_devices (apartment_id)
        WHERE provider = 'ttlock' AND scope = 'apartment' AND active = true AND apartment_id IS NOT NULL;
      INSERT INTO apartments VALUES ('${GORY}', 'Apartament - Widok na góry'), ('${RYNEK}', 'Apartament - Widok na rynek');`);
    const migration = readFileSync(join(__dirname, '../migrations/20261021190000_ttlock_lock_mappings.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    const rows = (await db.query(`
      SELECT a.name, d.provider_device_id::int AS lock_id, d.scope
      FROM apartment_access_devices d LEFT JOIN apartments a ON a.id = d.apartment_id
      ORDER BY lock_id`)).rows;
    assert.deepEqual(rows, [
      { name: 'Apartament - Widok na rynek', lock_id: 19051822, scope: 'apartment' },
      { name: 'Apartament - Widok na góry', lock_id: 19051854, scope: 'apartment' },
    ]);
  } finally {
    await db.close();
  }
});
