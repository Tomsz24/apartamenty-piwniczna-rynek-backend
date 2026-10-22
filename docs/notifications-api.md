# Powiadomienia push

## Co jest przygotowane

- iOS prosi o zgodę systemową i rejestruje aplikację w APNs.
- Po otrzymaniu tokenu APNs aplikacja rejestruje urządzenie w backendzie.
- Preferencje administratora są pobierane i zapisywane przez backend.
- Tokeny i preferencje są dostępne wyłącznie za pośrednictwem endpointów
  chronionych przez `SupabaseAdminGuard`.

## Migracja

Przed uruchomieniem endpointów należy wykonać migracje
`004_notification_infrastructure.sql`, `012_notification_preferences.sql` oraz
`014_notification_inbox_reads.sql` (jeśli nie były zastosowane) w docelowym
projekcie Supabase.

## Endpointy

- `POST /api/notifications/devices` rejestruje urządzenie APNs.
- `DELETE /api/notifications/devices` wyłącza token urządzenia.
- `GET /api/notifications/preferences` zwraca preferencje administratora.
- `PUT /api/notifications/preferences` zapisuje komplet preferencji.
- `GET /api/notifications/inbox` zwraca do 100 ostatnich zdarzeń i liczbę
  nieprzeczytanych.
  Każdy element ma `reservationId` i — dla nowych wiadomości — `conversationId`,
  dzięki którym aplikacja otwiera właściwą rezerwację albo rozmowę (te same pola
  są w payloadzie push).
- `PUT /api/notifications/inbox/:id/read` oznacza jedno zdarzenie jako
  przeczytane.
- `PUT /api/notifications/inbox/read-all` oznacza widoczne zdarzenia jako
  przeczytane.

Każde żądanie wymaga `Authorization: Bearer <Supabase access token>`.
Token urządzenia musi mieć 64 znaki szesnastkowe. Debug używa środowiska
`sandbox`, a konfiguracja Release używa `production`.

## Skąd biorą się powiadomienia

| Zdarzenie | Źródło | Preferencja |
| --- | --- | --- |
| `new_reservation` | trigger na `reservations` (nowa przyszła rezerwacja) | `newReservations` |
| `reservation_modified` | trigger: zmiana statusu, dat, apartamentu, gościa lub liczby gości | `reservationUpdates` |
| `reservation_cancelled` | trigger: przejście na `cancelled` | `cancellations` |
| `new_message` | webhook Hostex `message_created` → najnowsza wiadomość gościa | `newMessages` |
| `access_code_error` | trigger na `reservation_access_codes` (`sync_error`) | `accessCodeErrors` |
| `access_code_missing` | co 5 min: dzień przyjazdu, zamek TTLock, brak kodu `NOTIFICATION_MISSING_CODE_LEAD_MINUTES` przed zameldowaniem | `accessCodeErrors` |
| `arrival_message_reminder` | co 5 min: dzień przyjazdu po `NOTIFICATION_ARRIVAL_REMINDER_TIME`, wiadomość nieoznaczona jako wysłana | `arrivalMessageReminder` |

Zasady:

- Dotyczą tylko pobytów gości (`manual`, `hostex`, `booking_email`); blokady
  właściciela i obserwacje iCal nie tworzą powiadomień.
- Import historii (pobyt zakończony) i anulowane rezerwacje przy imporcie nie
  tworzą powiadomień. Odświeżenie synchronizacji bez zmian także nie.
- Każde zdarzenie ma `dedupe_key`, więc ponowna synchronizacja, duplikat
  webhooka czy kolejny przebieg crona nie tworzą duplikatów.
- Błąd przy zapisie powiadomienia nie blokuje zapisu rezerwacji ani kodu.
- Treść zawiera apartament, imię gościa i daty; nigdy kod do drzwi.

Triggery działają zawsze (skrzynka w aplikacji). Zdarzenia okresowe i wysyłka
push wymagają `NOTIFICATIONS_ENABLED=true`.

## Wysyłka push (APNs)

`NotificationDispatchService` co 15 sekund pobiera oczekujące zdarzenia
(`FOR UPDATE SKIP LOCKED`, priorytet `critical` → `low`) i wysyła je przez
HTTP/2 do APNs z tokenem JWT (ES256) podpisanym kluczem `.p8`:

- odbiorcy to włączone urządzenia iOS; preferencje administratora wyłączają
  wybrane typy (dostawa dostaje status `skipped`),
- urządzenie `sandbox` trafia do `api.sandbox.push.apple.com`, `production` do
  `api.push.apple.com`,
- `badge` to liczba nieprzeczytanych zdarzeń danego administratora, a payload
  zawiera `notificationId`, `eventType` i — jeśli są — `reservationId`,
  `conversationId`,
- odpowiedź `410` lub `BadDeviceToken` wyłącza urządzenie,
- `429`, `5xx` i błędy sieci ponawiają tylko nieudane dostawy (30 s, 60 s, …)
  maksymalnie 5 razy; urządzenia, które już dostały push, nie dostaną go drugi raz,
- zdarzenie starsze niż 12 godzin nie jest wysyłane (zostaje w skrzynce), więc
  włączenie APNs po przerwie nie zasypie telefonu zaległymi powiadomieniami,
- zdarzenie zawieszone w `processing` po awarii wraca do kolejki po 10 minutach.

`GET /api/notifications/push/status` (administrator) pokazuje, czy wysyłka jest
włączona i które dane APNs są skonfigurowane (bez wartości).

## Uruchomienie

1. W Apple Developer dla App ID `Tomsz24.apartamenty-piwniczna-rynek` włączyć
   Push Notifications i odświeżyć profile podpisywania.
2. Utworzyć klucz APNs (`.p8`), zanotować Key ID i Team ID.
3. Na serwerze zapisać plik poza repozytorium, np.
   `/home/deploy/secrets/apns.p8` z `chmod 600`, i ustawić `APNS_KEY_ID`,
   `APNS_TEAM_ID`, `APNS_PRIVATE_KEY_PATH`, `NOTIFICATIONS_ENABLED=true`.
4. Wykonać migrację `20261021180000_notification_event_producers.sql`.
5. Po restarcie sprawdzić `GET /api/notifications/push/status`.

Klucza `.p8` nie należy dodawać do repozytorium ani do aplikacji iOS.
