require('reflect-metadata');
require('dotenv').config({ quiet: true });

const { ConfigService } = require('@nestjs/config');
const { TtlockService } = require('../dist/ttlock/ttlock.service');

async function main() {
  const service = new TtlockService(new ConfigService(process.env));
  const status = service.getStatus();

  if (!status.ready) {
    console.error(JSON.stringify({ status }, null, 2));
    throw new Error('Integracja TTLock nie jest jeszcze gotowa do testu');
  }

  const [locks, gateways] = await Promise.all([
    service.listLocks(),
    service.listGateways(),
  ]);

  console.log(JSON.stringify({ status: service.getStatus(), locks, gateways }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Nieznany błąd TTLock');
  process.exitCode = 1;
});
