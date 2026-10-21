# Konfiguracja jednego backendu

Używamy jednego pliku `.env`. Wersjonowany `.env.example` jest wzorem bez
sekretów. Prywatny `.env` jest ignorowany przez Git; na hostingu te same zmienne
ustawiamy w panelu środowiska. Zmienne procesu mają pierwszeństwo przed plikiem.

## Uruchamianie

- `npm start` — uruchomienie backendu.
- `npm run start:dev` — ten sam backend i `.env`, z automatycznym restartem po zmianie kodu.
- `npm run start:debug` — ten sam backend i `.env`, z debuggerem.
- `npm run build && npm run start:prod` — zbudowanie i uruchomienie wersji serwerowej.

`start:dev` oznacza wyłącznie tryb pracy nad kodem. Korzysta z tej samej bazy,
rezerwacji i integracji co zwykły start. Nie uruchamiaj równolegle kilku kopii
backendu do testów integracji. Po zmianie `.env` zrestartuj proces.
Nie używamy `.env.development`, `APP_ENV` ani `DATABASE_HOST_EXPECTED`.
`NODE_ENV=production` można ustawić na hostingu; nie wybiera innego pliku `.env`.

## Sekcje konfiguracji

| Obszar | Wymagane ustawienia |
| --- | --- |
| Serwer | `PORT` (domyślnie 3000) |
| Baza | `DATABASE_URL`, `DATABASE_SSL` |
| Logowanie | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `ADMIN_EMAILS` (adresy po przecinku) |
| Hostex | `HOSTEX_ENABLED=true`, `HOSTEX_ACCESS_TOKEN`; automatyczny import: `HOSTEX_SYNC_ENABLED=true` |
| Zapisy Hostex | `HOSTEX_WRITES_ENABLED=true` i token z uprawnieniami zapisu |
| Webhook Hostex | `HOSTEX_WEBHOOK_SECRET` (sekret z Hostex) oraz `HOSTEX_ENABLED=true`; tylko na serwerze z publicznym HTTPS |
| E-maile | `RESERVATION_EMAIL_ENABLED=true`, `RESEND_API_KEY`, `RESERVATION_EMAIL_FROM`, `RESERVATION_EMAIL_TO`, `RESERVATION_EMAIL_START_AT` |
| Zamki | `TTLOCK_ENABLED`, dane klienta i konta/tokenów; zapisy kontroluje `TTLOCK_WRITES_ENABLED` |
| Powiadomienia push | `NOTIFICATIONS_ENABLED=true`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_PATH` lub `APNS_PRIVATE_KEY`; opcjonalnie `APNS_BUNDLE_ID` |
| Kody dostępu | `ACCESS_CODE_AUTOMATION_ENABLED`, skonfigurowany TTLock z zapisem oraz `ACCESS_CODE_ENCRYPTION_KEY` |

Adresy API, timeouty i retry mają domyślne wartości w kodzie; w przykładzie są
jawne, aby można było je dostosować. Tokeny TTLock są opcjonalną alternatywą dla
logowania kontem. Te ustawienia są nadal używane — nie są pozostałością po DEV.
Przełączniki zapisuj jako `true` lub `false`. Nie zmieniaj istniejącego klucza
szyfrowania kodów bez migracji zaszyfrowanych danych.

## Hostex zastępuje iCal

Usunięto aktywne pobieranie iCal, pakiet `node-ical` i zmienne `ICAL_SYNC_ENABLED`,
`ICAL_GORY_TOKEN`, `ICAL_RYNEK_TOKEN`. Harmonogram pozostaje w głównym module:
Hostex działa co 5 minut, kolejka e-mail co 30 sekund, cykl kodów co minutę,
jeśli odpowiednie funkcje są włączone.

Stary `POST /api/calendars/sync` zwraca HTTP 410 z informacją o przejściu na
`POST /api/hostex/sync/reservations`. Ten endpoint Hostex przyjmuje `apply: false`
dla podglądu i `apply: true` dla zapisu. Historyczne rekordy iCal oraz ich notatki
pozostają w bazie; import Hostex nadal potrafi przejąć pasujące stare rekordy.

## E-maile

Automatyczna wysyłka pozostaje wyłączona do wykonania migracji i ustawienia
stałej daty `RESERVATION_EMAIL_START_AT`. Odbiorca testowy:
`tomaszwojciechowski244@gmail.com`. Klucz Resend został zachowany.
Szczegóły: [reservation-emails.md](reservation-emails.md).
