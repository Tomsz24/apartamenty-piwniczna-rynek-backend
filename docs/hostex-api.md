# Hostex OpenAPI — etap tylko do odczytu

Moduł `src/hostex/` łączy backend bezpośrednio z REST API Hostex V3. Nie korzysta
z nieoficjalnego SDK i na tym etapie nie udostępnia żadnej operacji zapisującej.

## Konfiguracja

Utwórz w Hostex token z zakresem **read-only**:

1. `Workplace` → `OpenAPI`,
2. `+ Add new`,
3. wybierz zakres `read-only`,
4. zapisz token w lokalnym `.env`, nigdy w repozytorium ani Postmanie.

Minimalna konfiguracja:

```dotenv
HOSTEX_ENABLED=true
HOSTEX_WRITES_ENABLED=false
HOSTEX_ACCESS_TOKEN=
```

Pozostałe wartości mają bezpieczne ustawienia domyślne opisane w `.env.example`.
`HOSTEX_WRITES_ENABLED` jest zarezerwowane na przyszłość — obecny moduł zawsze
zwraca `mode=read_only` i nie zawiera metod zapisu.

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

Pierwsza wersja świadomie nie zwraca telefonu, e-maila ani pełnego rozliczenia
gościa. Udostępnia stabilne identyfikatory Hostex i kanału, obiekt, termin, liczbę
gości, status, imię gościa oraz czasy utworzenia rezerwacji. Rozszerzymy kontrakt
dopiero przy implementacji zapisu do naszej bazy.

## Obsługa błędów i bezpieczeństwo

- Hostex może zwrócić HTTP `200` również dla błędu. Klient zawsze sprawdza
  `error_code`; sukces to wyłącznie `0`.
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
- https://api-doc.hostex.io/reference/errors
