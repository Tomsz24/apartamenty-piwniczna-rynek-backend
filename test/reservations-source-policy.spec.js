const test = require('node:test');
const assert = require('node:assert/strict');
const { ReservationsService } = require('../dist/reservations/reservations.service');

test('reservation list hides legacy iCal rows by default but can include them for review', async () => {
  const queries = [];
  const service = new ReservationsService({
    query: async (text, values) => {
      queries.push({ text, values });
      return { rows: [] };
    },
  });

  await service.list({});
  assert.match(queries[0].text, /r\.origin IN \('manual', 'hostex'\)/);

  await service.list({ includeLegacy: true });
  assert.doesNotMatch(queries[1].text, /r\.origin IN \('manual', 'hostex'\)/);
});
