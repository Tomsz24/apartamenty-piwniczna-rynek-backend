#!/usr/bin/env node
// Builds the production .env from: the current server .env (kept as the base),
// secrets missing on the server copied from the local .env, and the public
// flags in deploy/production-flags.env (always win). Prints only key names and
// non-secret flag values — never secret values.
const { randomBytes } = require('crypto');
const { readFileSync, writeFileSync } = require('fs');

// Keys the backend no longer reads.
const REMOVED_KEYS = ['ICAL_GORY_TOKEN', 'ICAL_RYNEK_TOKEN'];

function parseEnv(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (match) entries.set(match[1], match[2].trim());
  }
  return entries;
}

function isEmpty(value) {
  return value === undefined || value === '' || value === '""' || value === "''";
}

function mergeEnv({ server, local, example, flags, webhookSecret, generateKey = () => randomBytes(32).toString('base64') }) {
  const result = new Map(server);
  const notes = [];
  for (const key of REMOVED_KEYS) result.delete(key);

  for (const key of example.keys()) {
    if (flags.has(key)) continue;
    if (isEmpty(result.get(key)) && !isEmpty(local.get(key))) {
      result.set(key, local.get(key));
    } else if (!result.has(key)) {
      result.set(key, example.get(key) ?? '');
    }
  }

  if (webhookSecret) result.set('HOSTEX_WEBHOOK_SECRET', webhookSecret);
  if (isEmpty(result.get('ACCESS_CODE_ENCRYPTION_KEY'))) {
    result.set('ACCESS_CODE_ENCRYPTION_KEY', generateKey());
    notes.push('Wygenerowano nowy ACCESS_CODE_ENCRYPTION_KEY — zapisz kopię w menedżerze haseł.');
  }
  for (const [key, value] of flags) result.set(key, value);

  // Example order first, then anything extra the server already had.
  const ordered = new Map();
  for (const key of [...example.keys(), ...flags.keys(), ...result.keys()]) {
    if (result.has(key) && !ordered.has(key)) ordered.set(key, result.get(key));
  }

  const report = [];
  for (const key of new Set([...server.keys(), ...ordered.keys()])) {
    const before = server.get(key);
    const after = ordered.get(key);
    const status = !ordered.has(key) ? 'usunięta'
      : !server.has(key) ? 'dodana'
      : before !== after ? 'zmieniona'
      : 'bez zmian';
    const shown = flags.has(key) ? after : isEmpty(after) ? '(puste)' : '(ukryte)';
    report.push({ key, status, value: ordered.has(key) ? shown : '' });
  }
  return { env: ordered, report, notes };
}

function serialize(env) {
  return [...env].map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function main(argv) {
  const args = Object.fromEntries(argv.reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []));
  const read = (path) => parseEnv(readFileSync(path, 'utf8'));
  const { env, report, notes } = mergeEnv({
    server: read(args.server),
    local: read(args.local),
    example: read(args.example),
    flags: read(args.flags),
    webhookSecret: process.env.HOSTEX_WEBHOOK_SECRET_INPUT?.trim() || '',
  });
  writeFileSync(args.out, serialize(env), { mode: 0o600 });

  const width = Math.max(...report.map((row) => row.key.length));
  for (const status of ['dodana', 'zmieniona', 'usunięta', 'bez zmian']) {
    const rows = report.filter((row) => row.status === status);
    if (rows.length === 0) continue;
    console.log(`\n${status.toUpperCase()} (${rows.length})`);
    for (const row of rows) console.log(`  ${row.key.padEnd(width)}  ${row.value}`);
  }
  const missing = report.filter((row) => row.value === '(puste)').map((row) => row.key);
  if (missing.length) console.log(`\nPuste wartości: ${missing.join(', ')}`);
  for (const note of notes) console.log(`\n⚠️  ${note}`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseEnv, mergeEnv, serialize };
