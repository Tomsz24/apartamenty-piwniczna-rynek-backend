// Optional real PostgreSQL engine test: set PGLITE_MODULE to an installed @electric-sql/pglite.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
test('PostgreSQL outbox captures business changes atomically and ignores sync noise', {skip: !process.env.PGLITE_MODULE}, async () => {
  const {PGlite} = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE apartments(id uuid PRIMARY KEY, name text);
      CREATE TABLE reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), apartment_id uuid, origin text, status text, start_date date, end_date date, guest_name text, note text, version integer DEFAULT 1, last_seen_at timestamptz, metadata jsonb);
      INSERT INTO apartments VALUES ('00000000-0000-0000-0000-000000000001','Góry');`);
    const migration = readFileSync(join(__dirname,'../migrations/20261021144218_reservation_email_outbox.sql'),'utf8');
    await db.exec(migration);
    await db.exec(migration); // repeatable
    const create = async (status='confirmed',origin='hostex') => (await db.query(`INSERT INTO reservations(apartment_id,origin,status,start_date,end_date,guest_name) VALUES('00000000-0000-0000-0000-000000000001',$1,$2,CURRENT_DATE+10,CURRENT_DATE+12,'Anna') RETURNING id`, [origin,status])).rows[0].id;
    const id = await create();
    let rows = (await db.query('SELECT * FROM reservation_email_outbox')).rows;
    assert.equal(rows.length,1); assert.equal(rows[0].event_type,'new_reservation');
    assert.equal(rows[0].snapshot.apartment_name,'Góry');
    await db.query(`UPDATE reservations SET last_seen_at=NOW(),version=version+1,metadata='{"sync":true}' WHERE id=$1`,[id]);
    assert.equal((await db.query('SELECT * FROM reservation_email_outbox')).rows.length,1);
    await db.query(`UPDATE reservations SET guest_name='Jan' WHERE id=$1`,[id]);
    rows = (await db.query("SELECT * FROM reservation_email_outbox WHERE event_type='reservation_modified'")).rows;
    assert.equal(rows[0].previous_snapshot.guest_name,'Anna'); assert.equal(rows[0].snapshot.guest_name,'Jan');
    await db.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`,[id]);
    assert.equal((await db.query("SELECT * FROM reservation_email_outbox WHERE event_type='reservation_cancelled'")).rows.length,1);
    await db.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`,[id]);
    await create('blocked','manual'); await create('cancelled'); await create('confirmed','booking_ical');
    assert.equal((await db.query('SELECT * FROM reservation_email_outbox')).rows.length,3);
    await db.exec('BEGIN'); await create(); await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT * FROM reservation_email_outbox')).rows.length,3);
    const security = (await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='reservation_email_outbox'")).rows[0];
    assert.equal(security.relrowsecurity,true);
    await db.exec('SET ROLE anon');
    await assert.rejects(db.query('SELECT * FROM reservation_email_outbox'), /permission denied/);
  } finally {await db.close();}
});

test('coalesces quick successive changes into one email and stays quiet after cancellation', {skip: !process.env.PGLITE_MODULE}, async () => {
  const {PGlite} = require(process.env.PGLITE_MODULE);
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE apartments(id uuid PRIMARY KEY, name text);
      CREATE TABLE reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), apartment_id uuid, origin text, status text, start_date date, end_date date, guest_name text, note text, total_rate_amount numeric, version integer DEFAULT 1, last_seen_at timestamptz, metadata jsonb);
      INSERT INTO apartments VALUES ('00000000-0000-0000-0000-000000000001','Rynek');`);
    await db.exec(readFileSync(join(__dirname,'../migrations/20261021144218_reservation_email_outbox.sql'),'utf8'));
    const coalesce = readFileSync(join(__dirname,'../migrations/20261022090000_reservation_email_coalesce.sql'),'utf8');
    await db.exec(coalesce);
    await db.exec(coalesce); // repeatable
    const outbox = async () => (await db.query('SELECT event_type, snapshot, previous_snapshot, next_attempt_at > NOW() AS waiting FROM reservation_email_outbox ORDER BY created_at')).rows;
    const create = async (name) => (await db.query(`INSERT INTO reservations(apartment_id,origin,status,start_date,end_date,guest_name,total_rate_amount) VALUES('00000000-0000-0000-0000-000000000001','hostex','confirmed',CURRENT_DATE+1,CURRENT_DATE+3,$1,500) RETURNING id`, [name])).rows[0].id;
    const markSent = () => db.query(`UPDATE reservation_email_outbox SET status='sent', first_attempt_at=NOW()`);

    // The app creates the stay and adds the note a moment later: one "new" email with the note.
    const id = await create('Anna');
    await db.query(`UPDATE reservations SET note='Łóżeczko dla dziecka' WHERE id=$1`, [id]);
    let rows = await outbox();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_type, 'new_reservation');
    assert.equal(rows[0].snapshot.note, 'Łóżeczko dla dziecka');
    assert.equal(rows[0].waiting, true);

    // After it went out, two quick edits make one "modified" email whose diff spans both.
    await markSent();
    await db.query(`UPDATE reservations SET guest_name='Anna Nowak' WHERE id=$1`, [id]);
    await db.query(`UPDATE reservations SET note='Łóżeczko i krzesełko' WHERE id=$1`, [id]);
    rows = await outbox();
    assert.equal(rows.length, 2);
    assert.equal(rows[1].event_type, 'reservation_modified');
    assert.equal(rows[1].previous_snapshot.guest_name, 'Anna');
    assert.equal(rows[1].previous_snapshot.note, 'Łóżeczko dla dziecka');
    assert.equal(rows[1].snapshot.guest_name, 'Anna Nowak');
    assert.equal(rows[1].snapshot.note, 'Łóżeczko i krzesełko');

    // Cancelling replaces the waiting "modified" mail; Hostex zeroing the price afterwards is silent.
    await db.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`, [id]);
    await db.query(`UPDATE reservations SET total_rate_amount=0 WHERE id=$1`, [id]);
    rows = await outbox();
    assert.deepEqual(rows.map((row) => row.event_type), ['new_reservation', 'reservation_cancelled']);
    assert.equal(rows[1].previous_snapshot.guest_name, 'Anna');

    // Created and cancelled before anything was sent: no email at all.
    const mistake = await create('Pomyłka');
    await db.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`, [mistake]);
    assert.equal((await outbox()).length, 2);

    // Edits undone before sending leave nothing to report.
    await markSent();
    const other = await create('Jan');
    await markSent();
    await db.query(`UPDATE reservations SET guest_name='Janek' WHERE id=$1`, [other]);
    await db.query(`UPDATE reservations SET guest_name='Jan' WHERE id=$1`, [other]);
    const forOther = (await db.query(`SELECT event_type FROM reservation_email_outbox WHERE reservation_id=$1`, [other])).rows;
    assert.deepEqual(forOther.map((row) => row.event_type), ['new_reservation']);
  } finally {await db.close();}
});
