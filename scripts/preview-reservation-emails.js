// npm run build && node scripts/preview-reservation-emails.js
const {mkdirSync,writeFileSync} = require('node:fs');
const {join} = require('node:path');
const {renderReservationEmail} = require('../dist/notifications/reservation-email.template');
const directory = join(__dirname, '../docs/email-previews');
mkdirSync(directory, {recursive:true});
const snapshot = {id:'DEMO-2026-001',apartment_name:'Apartament z widokiem na góry',start_date:'2026-12-11',end_date:'2026-12-14',guest_name:'Anna Kowalska (dane przykładowe)',guest_count:2,adults:2,status:'confirmed',total_rate_amount:1350,currency:'PLN',note:'Przyjazd około godziny 17:00.'};
for (const event_type of ['new_reservation','reservation_modified','reservation_cancelled']) {
  const email = renderReservationEmail({event_type,snapshot:{...snapshot,status:event_type === 'reservation_cancelled' ? 'cancelled' : 'confirmed'},previous_snapshot:event_type === 'reservation_modified' ? {...snapshot,end_date:'2026-12-13',total_rate_amount:900} : null});
  writeFileSync(join(directory, `${event_type}.html`),email.html);
}
console.log(directory);
