const test = require('node:test');
const assert = require('node:assert/strict');
const { HostexSyncService } = require('../dist/hostex/hostex-sync.service');

const counts = {
  created: 2,
  updated: 3,
  adopted_ical: 1,
  conflict: 0,
  unmapped: 0,
};

function createService(enabled) {
  return new HostexSyncService({}, {}, {
    get: (key) => key === 'HOSTEX_SYNC_ENABLED' ? String(enabled) : undefined,
  });
}

test('automatic Hostex sync is opt-in and runs on the five-minute schedule when enabled', async () => {
  const disabled = createService(false);
  disabled.syncReservations = async () => {
    throw new Error('disabled sync should not run');
  };
  await disabled.handleScheduledSync();
  assert.equal(disabled.getAutomaticSyncStatus().enabled, false);
  assert.equal(disabled.getAutomaticSyncStatus().lastStartedAt, null);

  const enabled = createService(true);
  enabled.syncReservations = async (apply) => {
    assert.equal(apply, true);
    return { mode: 'applied', fetched: 6, mappedProperties: 2, counts, items: [] };
  };
  await enabled.handleScheduledSync();
  const status = enabled.getAutomaticSyncStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.intervalMinutes, 5);
  assert.equal(status.inProgress, false);
  assert.match(status.lastStartedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(status.lastFinishedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(status.lastSucceededAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(status.lastError, null);
  assert.deepEqual(status.counts, counts);
});

test('automatic Hostex sync does not start a second overlapping run', async () => {
  const service = createService(true);
  let release;
  let starts = 0;
  service.syncReservations = async () => {
    starts += 1;
    await new Promise((resolve) => { release = resolve; });
    return { mode: 'applied', fetched: 0, mappedProperties: 0, counts, items: [] };
  };

  const first = service.handleScheduledSync();
  await new Promise((resolve) => setImmediate(resolve));
  await service.handleScheduledSync();
  assert.equal(starts, 1);
  assert.equal(service.getAutomaticSyncStatus().inProgress, true);

  release();
  await first;
  assert.equal(service.getAutomaticSyncStatus().inProgress, false);
});

test('stale iCal availability blocks do not conflict with Hostex stays', async () => {
  const service = createService(false);
  const queryable = {
    query: async (text) => {
      if (text.includes('reservation_source_refs')) return { rows: [] };
      return {
        rows: [{
          id: 'legacy-ical',
          origin: 'booking_ical',
          start_date: '2027-06-01',
          end_date: '2028-02-10',
        }],
      };
    },
  };
  const plan = await service.planReservation(queryable, {
    propertyId: 12761008,
    stayCode: 'stay-1',
    reservationCode: 'reservation-1',
    checkInDate: '2027-07-01',
    checkOutDate: '2027-07-05',
    status: 'accepted',
  }, {
    hostexPropertyId: 12761008,
    hostexTitle: 'Property #2',
    apartmentId: 'apartment-1',
    apartmentName: 'Apartament - Widok na góry',
  });

  assert.equal(plan.action, 'created');
});
