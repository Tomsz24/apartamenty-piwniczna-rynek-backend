const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { ConfigService } = require('@nestjs/config');
const { IcalSyncService } = require('../dist/ical-sync/ical-sync.service');

test('ICAL_SYNC_ENABLED=false prevents startup and manual iCal synchronization', async () => {
  let databaseQueries = 0;
  const pool = {
    query: async () => {
      databaseQueries += 1;
      throw new Error('Baza nie powinna zostać odpytana');
    },
  };
  const service = new IcalSyncService(
    pool,
    new ConfigService({ ICAL_SYNC_ENABLED: 'false' }),
  );

  await service.onModuleInit();
  await service.handleCron();
  await assert.rejects(service.forceSync(), /wyłączona/);
  assert.equal(databaseQueries, 0);
});
