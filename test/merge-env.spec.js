const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv, mergeEnv, serialize } = require('../scripts/merge-env');

const env = (text) => parseEnv(text);

test('keeps server values, fills missing secrets from local, applies flags and drops legacy keys', () => {
  const { env: result, report, notes } = mergeEnv({
    server: env('DATABASE_URL=server-db\nNODE_ENV=production\nICAL_RYNEK_TOKEN=old\nHOSTEX_ACCESS_TOKEN=\n'),
    local: env('DATABASE_URL=local-db\nHOSTEX_ACCESS_TOKEN=tok\nRESEND_API_KEY=re_x\nHOSTEX_SYNC_ENABLED=true\n'),
    example: env('DATABASE_URL=\nHOSTEX_ACCESS_TOKEN=\nRESEND_API_KEY=\nHOSTEX_SYNC_ENABLED=false\nACCESS_CODE_ENCRYPTION_KEY=\nTTLOCK_CLIENT_ID=\n'),
    flags: env('HOSTEX_SYNC_ENABLED=false\nNOTIFICATIONS_ENABLED=true\n'),
    webhookSecret: 'whsec',
    generateKey: () => 'generated-key',
  });

  assert.equal(result.get('DATABASE_URL'), 'server-db');
  assert.equal(result.get('HOSTEX_ACCESS_TOKEN'), 'tok');
  assert.equal(result.get('RESEND_API_KEY'), 're_x');
  assert.equal(result.get('HOSTEX_SYNC_ENABLED'), 'false');
  assert.equal(result.get('NOTIFICATIONS_ENABLED'), 'true');
  assert.equal(result.get('HOSTEX_WEBHOOK_SECRET'), 'whsec');
  assert.equal(result.get('ACCESS_CODE_ENCRYPTION_KEY'), 'generated-key');
  assert.equal(result.get('TTLOCK_CLIENT_ID'), '');
  assert.equal(result.get('NODE_ENV'), 'production');
  assert.equal(result.has('ICAL_RYNEK_TOKEN'), false);
  assert.equal(notes.length, 1);

  const byKey = Object.fromEntries(report.map((row) => [row.key, row]));
  assert.deepEqual(byKey.ICAL_RYNEK_TOKEN, { key: 'ICAL_RYNEK_TOKEN', status: 'usunięta', value: '' });
  assert.equal(byKey.HOSTEX_ACCESS_TOKEN.status, 'zmieniona');
  assert.equal(byKey.HOSTEX_ACCESS_TOKEN.value, '(ukryte)');
  assert.equal(byKey.NOTIFICATIONS_ENABLED.value, 'true');
  assert.equal(byKey.TTLOCK_CLIENT_ID.value, '(puste)');
  // No secret value ever appears in the report.
  assert.equal(JSON.stringify(report).match(/tok|re_x|server-db|whsec|generated-key/), null);
});

test('never replaces an existing encryption key and serializes in a stable order', () => {
  const { env: result, notes } = mergeEnv({
    server: env('ACCESS_CODE_ENCRYPTION_KEY=keep-me\n'),
    local: env('ACCESS_CODE_ENCRYPTION_KEY=local-key\n'),
    example: env('PORT=3000\nACCESS_CODE_ENCRYPTION_KEY=\n'),
    flags: env('PORT=3000\n'),
    generateKey: () => { throw new Error('must not generate'); },
  });
  assert.equal(result.get('ACCESS_CODE_ENCRYPTION_KEY'), 'keep-me');
  assert.deepEqual(notes, []);
  assert.equal(serialize(result), 'PORT=3000\nACCESS_CODE_ENCRYPTION_KEY=keep-me\n');
});

test('parser ignores comments and blank lines and keeps values containing =', () => {
  const parsed = parseEnv('# komentarz\n\nDATABASE_URL=postgres://u:p@h/db?sslmode=require\n  PORT = 3000\n');
  assert.deepEqual([...parsed], [['DATABASE_URL', 'postgres://u:p@h/db?sslmode=require'], ['PORT', '3000']]);
});
