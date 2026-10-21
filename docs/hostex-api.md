# Hostex OpenAPI — rezerwacje i synchronizacja

Moduł `src/hostex/` łączy backend bezpośrednio z REST API Hostex V3. Import
rezerwacji używa wyłącznie odczytów. Tworzenie, edycja i anulowanie rezerwacji
oraz wysyłanie wiadomości są operacjami zapisującymi i pozostają domyślnie
wyłączone.

## Konfiguracja

Do pobierania danych używaj tokenu **read-only**. Do tworzenia, edycji lub
anulowania rezerwacji utwórz osobny token z zakresem **writable**:

1. `Workplace` → `OpenAPI`,
2. `+ Add new`,
3. wybierz zakres `read-only`,
4. zapisz token w lokalnym `.env`, nigdy w repozytorium ani Postmanie.

Minimalna konfiguracja:

```dotenv
HOSTEX_ENABLED=true
HOSTEX_SYNC_ENABLED=false
HOSTEX_WRITES_ENABLED=false
HOSTEX_ACCESS_TOKEN=
```

Pozostałe wartości mają bezpieczne ustawienia domyślne opisane w `.env.example`.
`HOSTEX_WRITES_ENABLED` pozostaje `false` domyślnie. Włączenie wymaga tokenu
Hostex z prawem zapisu. Wtedy aplikacja tworzy bezpośrednie rezerwacje w Hostex
przez kanał własny o nazwie `Mobile App`, płatność gotówką przez metodę `Cash`,
a następnie odczytuje utworzony pobyt i zapisuje go lokalnie jako `hostex`.
Nazwy i ID kanału oraz metody płatności są pobierane ze słowników Hostex przy
tworzeniu, nie są zakodowane na stałe. Identyfikator klienta aplikacji jest
wysyłany jako Hostex `channel_id`, dzięki czemu ponowienie po niejednoznacznym
timeout nie tworzy drugiej rezerwacji.

Edycja danych gościa i terminu rezerwacji Hostex jest najpierw wysyłana do
Hostex, a anulowanie korzysta z jego endpointu anulowania rezerwacji ręcznych.
Anulowanie rezerwacji pochodzącej z Booking.com lub innego kanału OTA jest
blokowane — Hostex API nie pozwala anulować takich rezerwacji tym endpointem.
Lokalna notatka i wiek dzieci nadal pozostają rozszerzeniem w naszej bazie.

Automatyczny import do naszej bazy włącza osobna flaga
`HOSTEX_SYNC_ENABLED=true`. Po włączeniu backend wykona synchronizację przy
starcie i następnie co 5 minut. Każdy przebieg pobiera aktualne strony
rezerwacji z Hostex i idempotentnie aktualizuje lokalne rekordy. Synchronizacja
nie wysyła zmian rezerwacji do Hostex. Przed włączeniem sprawdź przypisanie wszystkich
properties Hostex do właściwych apartamentów. Import ma osobny tryb podglądu,
który nie zapisuje zmian.

## Endpointy backendu

Wszystkie wymagają tokenu administratora Supabase w `Authorization: Bearer ...`.
Token Hostex pozostaje wyłącznie na serwerze.

### `GET /api/hostex/status`

Nie łączy się z Hostex. Pokazuje, czy moduł jest włączony i ma lokalnie
skonfigurowany token, bez ujawniania jego wartości.

Przykład przed dodaniem tokenu:

```json
{
  "enabled": false,
  "ready": false,
  "mode": "read_only",
  "writesEnabled": false,
  "accessTokenConfigured": false,
  "apiBaseUrlConfigured": true
}
```

### `GET /api/hostex/properties`

Obsługiwane parametry: `offset`, `limit`, `id`, `groupId`, `tagId`.

Backend mapuje parametry na nazwy Hostex, odrzuca nieprawidłowe zakresy i zwraca
wyłącznie znane pola obiektu, kanałów, grup i tagów.

### `GET /api/hostex/reservations`

Obsługiwane parametry:

- `offset`, `limit`,
- `reservationCode`, `channelId`, `propertyId`,
- `status`, `channelType`, `orderBy`,
- `startCheckInDate`, `endCheckInDate`,
- `startCheckOutDate`, `endCheckOutDate`.

Endpoint zwraca tylko wybrane, potrzebne dane: identyfikatory Hostex i kanału,
obiekt, termin, status, dostępne dane kontaktowe, liczbę dorosłych, dzieci,
niemowląt i zwierząt, cenę całkowitą, walutę oraz dostępne podsumowanie
płatności. Wiek dzieci nie jest udokumentowany jako pole rezerwacji Hostex;
można go uzupełnić lokalnie w naszej aplikacji. Nie zwracamy listy gości,
dokumentów ani surowej odpowiedzi API.

`paymentStatus` i `amountReceived` są przekazywane tylko wtedy, gdy Hostex
zwróci rozpoznawalne wartości w odpowiedzi rezerwacji. Status kolekcji płatności
nie zawsze oznacza, że Hostex raportuje faktycznie otrzymaną kwotę, szczególnie
przy rezerwacjach opłacanych przez kanał zewnętrzny. Do wiarygodnego zestawienia
wpływów potrzebny jest osobny odczyt i agregacja transakcji Hostex po
`reservation_code`; nie należy wyliczać zapłaconej kwoty z samego statusu.

### `GET /api/hostex/conversations`

Proxy listy rozmów Hostex, parametry `offset` i `limit` (1–100, domyślnie 50).
Zwraca bezpieczne podsumowanie: identyfikator rozmowy, kanał, gościa, obiekt,
termin pobytu, ostatnią wiadomość i licznik nieprzeczytanych. Nie zapisuje
historii w naszej bazie; dane są pobierane z Hostex na żądanie.

### `GET /api/hostex/conversations/:conversationId`

Pobiera szczegóły i historię wybranej rozmowy. Zwracane są tylko tekst, kierunek,
czas oraz linki załączników. Nieznane pola odpowiedzi Hostex są pomijane.
Do powiązania z rezerwacją aplikacja używa `conversationId` z rezerwacji, a
metadane terminu i apartamentu służą jako dodatkowy kontekst.

### `POST /api/hostex/conversations/:conversationId/messages`

Wysyła wiadomość tekstową do wskazanej rozmowy Hostex. Backend odmawia wysyłki,
chyba że `HOSTEX_WRITES_ENABLED=true`; użyj tylko po skonfigurowaniu tokenu z
prawem zapisu. Wysyłka nie jest idempotentna: po timeout sprawdź rozmowę w
Hostex przed ponowieniem, bo pierwsza próba mogła już dotrzeć. Identyfikator
rozmowy jest dostępny jako `conversationId` w odpowiedzi
`GET /api/reservations`.

### Mapowanie i import do naszej bazy

`GET /api/hostex/mappings` zwraca lokalne apartamenty i properties Hostex.
Migracja `006` wstępnie przypisuje `12761007` do „Widok na rynek” (adres Rynek 3)
i `12761008` do „Widok na góry”. Sprawdź tę parę w odpowiedzi przed importem.
W razie potrzeby mapowanie można zmienić:

```http
POST /api/hostex/properties/12761007/mapping
Content-Type: application/json

{"apartmentId":"<uuid-apartamentu>"}
```

`POST /api/hostex/sync/reservations` bez `apply` wykonuje podgląd: pobiera
wszystkie strony rezerwacji, pokazuje przypisania, istniejące referencje i
kolizje, ale nie zapisuje danych. Dopiero `{"apply":true}` tworzy/aktualizuje
rekordy w `reservations` oraz referencje `reservation_source_refs`. `stay_code`
jest identyfikatorem idempotencji, `reservation_code` pozostaje w metadanych.
`accepted` mapuje się na `confirmed`, `wait_accept`/`wait_pay` na `tentative`, a
`cancelled`/`denied`/`timeout` na `cancelled`. Nieznany status trafia do
`needs_review` wraz z wpisem w kolejce kontroli.

Dokładna zgodność terminu z pojedynczą starą rezerwacją `booking_ical` zachowuje
jej UUID i notatkę. Pozostałe wpisy iCal są archiwalne: nie pojawiają się na
aktywnym kalendarzu i nie blokują terminów Hostex. Kolizje z aktywnymi wpisami
`hostex` lub `manual` trafiają do `reservation_review_items`; import nie tworzy
drugiej rezerwacji w tym samym terminie. Nowe rekordy nie uruchamiają
automatycznie operacji na zamku.
`GET /api/hostex/sync/issues` udostępnia otwarte kolizje i nieznane statusy do
ręcznej kontroli.

`GET /api/hostex/sync/status` pokazuje, czy automatyczny import jest włączony,
czy trwa, kiedy zakończył się ostatni przebieg, jego liczniki oraz bezpieczny
komunikat ostatniego błędu. Synchronizacja cykliczna nie blokuje startu serwera
i nie uruchomi równoległego przebiegu, jeśli poprzedni wciąż trwa.

## Webhook Hostex

`POST /api/hostex/webhook` przyjmuje powiadomienia Hostex. Endpoint nie używa
logowania administratora; uwierzytelnia go wyłącznie nagłówek
`Hostex-Webhook-Secret-Token`, porównywany w stałym czasie z
`HOSTEX_WEBHOOK_SECRET`. Bez ustawionego sekretu endpoint zwraca `404`, a zły
sekret daje `401`.

Hostex czeka najwyżej 5 sekund i nie ponawia zgubionych powiadomień, a ponowienia
po przekroczeniu czasu mogą tworzyć duplikaty. Dlatego endpoint jedynie zapisuje
zdarzenie w tabeli `hostex_webhook_events` i od razu odpowiada `200`:

- deduplikacja po `event_id` (ULID Hostex), a gdy go brak — po skrócie treści,
- zapisywane są tylko identyfikatory (`reservation_code`, `stay_code`,
  `property_id`) i lista nazw pól; dane gościa i surowy payload nie trafiają do
  bazy ani logów,
- `reservation_created` i `reservation_updated` uruchamiają synchronizację
  wskazanej rezerwacji z API Hostex (payload jest tylko sygnałem); bez kodu
  rezerwacji albo gdy filtr nic nie zwróci, wykonywana jest pełna synchronizacja,
- `authorization_revoked` jest logowane jako błąd: trzeba ponownie połączyć API
  i zapisać nowy sekret,
- `message_created` pobiera rozmowę z API Hostex i tworzy powiadomienie
  `new_message` dla najnowszej wiadomości gościa (nasze własne odpowiedzi są
  pomijane), zob. `docs/notifications-api.md`,
- pozostałe typy (recenzje, kalendarz, nowe) są oznaczane jako `ignored`, a
  nieznane pola są pomijane.

Kolejka jest przetwarzana zaraz po odbiorze oraz co minutę. Błąd przetwarzania
ponawia zdarzenie z rosnącym odstępem (1, 2, 4, 8 min); po 5 próbach dostaje
status `failed`. Synchronizacja co 5 minut (`HOSTEX_SYNC_ENABLED=true`) zostaje
jako kontrola na wypadek zgubionych powiadomień.

`GET /api/hostex/webhook/status` (administrator) pokazuje, czy webhook jest
włączony, kiedy przyszło ostatnie zdarzenie i liczniki statusów z 7 dni.

Rejestracja: w panelu Hostex (Open API → Webhooks → Add new) podaj
`https://api.api.apartamenty-piwniczna-rynek.pl/api/hostex/webhook` — bez
przekierowań, bo Hostex zamienia przekierowany POST na GET. Sekret pokazywany
jest tylko raz; jeśli zginie, usuń webhook i utwórz go ponownie. Webhook działa
tylko na serwerze z publicznym HTTPS, nie lokalnie.

Przed użyciem endpointów należy wykonać migrację
`migrations/006_hostex_reservations.sql`. Połączenie bazy działa na produkcji
tylko po ręcznym wdrożeniu migracji i backendu.

## Obsługa błędów i bezpieczeństwo

- Hostex może zwrócić HTTP `200` również dla błędu. Klient zawsze sprawdza
  `error_code`. Dokumentacja opisuje sukces jako `0`, natomiast prawdziwy token
  hosta zwrócił `200` i `Done.`; klient obsługuje oba warianty jako sukces.
- Kod `420` oznacza problem planu/subskrypcji, `401` tokenu lub zakresu, a `429`
  limit zapytań.
- Odczyt po przejściowym błędzie `500/502/503/504` jest ponawiany najwyżej tyle
  razy, ile ustawiono w `HOSTEX_READ_RETRY_COUNT` (domyślnie raz).
- Nieznane pola odpowiedzi są ignorowane i nie trafiają do klienta mobilnego.
- Token, telefon, e-mail i surowy payload nie są zapisywane w logach.

Dokumentacja dostawcy:

- https://api-doc.hostex.io/reference/authentication
- https://api-doc.hostex.io/reference/query-properties
- https://api-doc.hostex.io/reference/query-reservations
- https://api-doc.hostex.io/reference/query-transactions
- https://api-doc.hostex.io/reference/errors
