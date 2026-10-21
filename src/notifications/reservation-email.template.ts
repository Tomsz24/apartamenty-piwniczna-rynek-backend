export type ReservationEmailEvent = {
  event_type: 'new_reservation' | 'reservation_modified' | 'reservation_cancelled';
  snapshot: Record<string, any>;
  previous_snapshot: Record<string, any> | null;
};

export const emailFields: Record<string, string> = {
  apartment_name: 'Apartament', start_date: 'Przyjazd', end_date: 'Wyjazd',
  guest_name: 'Gość', guest_count: 'Liczba gości', adults: 'Dorośli', children: 'Dzieci',
  child_ages: 'Wiek dzieci', infants: 'Niemowlęta', pets: 'Zwierzęta',
  guest_phone: 'Telefon', guest_email: 'E-mail gościa', status: 'Status',
  total_rate_amount: 'Wartość rezerwacji', amount_received: 'Otrzymano',
  currency: 'Waluta', payment_status: 'Status płatności', note: 'Notatka',
};
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));
function display(key: string, value: any): string {
  if (value == null || value === '') return '—';
  if (key.endsWith('_date')) return String(value).slice(0, 10).split('-').reverse().join('.');
  if (key === 'status') return ({ confirmed: 'Potwierdzona', cancelled: 'Anulowana', tentative: 'Wstępna', needs_review: 'Do sprawdzenia', blocked: 'Blokada' })[value] || String(value);
  return Array.isArray(value) ? value.join(', ') : String(value);
}

export function renderReservationEmail(event: ReservationEmailEvent) {
  const data = event.snapshot;
  const [title, accent, intro] = {
    new_reservation: ['Nowa rezerwacja', '#246451', 'Nowy pobyt został zapisany w systemie.'],
    reservation_modified: ['Zmiana rezerwacji', '#a56c20', 'Dane pobytu zostały zaktualizowane. Poniżej znajdziesz szczegóły zmian.'],
    reservation_cancelled: ['Anulowana rezerwacja', '#a54848', 'Rezerwacja została anulowana. Sprawdź poniższe szczegóły pobytu.'],
  }[event.event_type];
  const rows = Object.entries(emailFields).filter(([key]) => data[key] != null && data[key] !== '');
  const changes = event.event_type === 'reservation_modified' && event.previous_snapshot
    ? Object.entries(emailFields).filter(([key]) => JSON.stringify(data[key] ?? null) !== JSON.stringify(event.previous_snapshot![key] ?? null)) : [];
  const details = rows.map(([key, label]) => `<tr><td style="padding:11px 0;border-bottom:1px solid #eee9e1;color:#73766f;width:42%;vertical-align:top">${label}</td><td style="padding:11px 0;border-bottom:1px solid #eee9e1;color:#243c33;white-space:pre-wrap;word-break:break-word">${escape(display(key, data[key]))}</td></tr>`).join('');
  const diff = changes.length ? `<h2 style="font-size:19px;margin-top:28px">Co się zmieniło?</h2><table role="presentation" width="100%" cellspacing="0" style="font-size:14px">${changes.map(([key, label]) => `<tr><td style="padding:10px;border-bottom:1px solid #eee9e1">${label}<br><span style="color:#8b8c85;text-decoration:line-through">${escape(display(key, event.previous_snapshot![key]))}</span><br><strong style="color:${accent}">${escape(display(key, data[key]))}</strong></td></tr>`).join('')}</table>` : '';
  const subject = `${title} · ${data.apartment_name || 'Apartamenty Piwniczna Rynek'} · ${display('start_date', data.start_date)}`.replace(/[\r\n]/g, ' ');
  const text = `${title}\n${intro}\n\n${rows.map(([key, label]) => `${label}: ${display(key, data[key])}`).join('\n')}${changes.length ? '\n\nCo się zmieniło?\n' + changes.map(([key, label]) => `${label}: ${display(key, event.previous_snapshot![key])} → ${display(key, data[key])}`).join('\n') : ''}\n\nID rezerwacji: ${data.id}\nPowiadomienie dla obsługi obiektu.`;
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head><body style="margin:0;background:#f4f1eb;font-family:Arial,Helvetica,sans-serif;color:#243c33"><div style="display:none;max-height:0;overflow:hidden">${escape(subject)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f1eb"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e5dfd4;border-radius:14px;overflow:hidden"><tr><td style="background:#203e34;padding:30px;color:#fff"><div style="font-size:11px;letter-spacing:3px;color:#d9c6a2">APARTAMENTY</div><div style="font-family:Georgia,serif;font-size:29px;margin-top:8px">Piwniczna Rynek</div><div style="font-size:12px;color:#c0d0c7;margin-top:12px">REZERWACJE · POWIADOMIENIE DLA OBSŁUGI</div></td></tr><tr><td style="padding:30px"><span style="display:inline-block;background:${accent};color:#fff;padding:7px 12px;border-radius:20px;font-size:12px">${escape(title)}</span><h1 style="font-family:Georgia,serif;font-weight:normal;font-size:28px;margin:20px 0 12px">${escape(data.apartment_name || 'Twój apartament')}</h1><p style="color:#73766f;font-size:14px;line-height:1.7">${intro}</p><div style="background:#f4f1eb;padding:18px;border-radius:8px;margin:22px 0;font-size:20px;text-align:center">${escape(display('start_date', data.start_date))} &nbsp;→&nbsp; ${escape(display('end_date', data.end_date))}</div><table role="presentation" width="100%" cellspacing="0" style="font-size:14px;line-height:1.5">${details}</table>${diff}</td></tr><tr><td style="padding:20px 30px;background:#faf9f6;color:#85877f;font-size:11px;line-height:1.7;word-break:break-all">ID rezerwacji: ${escape(data.id)}<br>Automatyczna wiadomość dla obsługi Apartamentów Piwniczna Rynek.</td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}
