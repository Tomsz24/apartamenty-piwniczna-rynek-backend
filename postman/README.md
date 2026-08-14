# Postman — Apartamenty Piwniczna Rynek

Do Postmana zaimportuj oba pliki:

1. `Apartamenty-Piwniczna-Rynek.postman_collection.json`,
2. `Apartamenty-Local.postman_environment.json`.

Następnie wybierz środowisko **Apartamenty Local** i uzupełnij:

- `supabaseUrl` — `SUPABASE_URL` z lokalnego `.env`,
- `supabasePublishableKey` — `SUPABASE_PUBLISHABLE_KEY` z `.env`,
- `adminEmail` — email obecny w `ADMIN_EMAILS`,
- `adminPassword` — hasło tego użytkownika Supabase.

Nie wpisuj do Postmana `service_role`, `DATABASE_URL`, sekretów TTLock ani
`ACCESS_CODE_ENCRYPTION_KEY`. Nie wpisuj również `HOSTEX_ACCESS_TOKEN`: backend
odczytuje go wyłącznie ze swojego `.env`.

Uruchom backend przez `npm run start:dev`, a następnie wyślij request
`00 Auth — Supabase / Pobierz token Supabase`. Skrypt zapisze `accessToken` i
`refreshToken` w aktywnym środowisku. Reszta kolekcji dziedziczy Bearer Token.

Zalecana kolejność pierwszego bezpiecznego testu:

1. `Pobierz token Supabase`,
2. `Sprawdź aktualnego użytkownika`,
3. `Sprawdź połączenie z bazą`,
4. `Status TTLock`,
5. `Lista zamków`,
6. ręcznie wybierz właściwy `lockId`,
7. `Możliwości kodów zamków`,
8. `Bezpieczny podgląd kodu — bez zapisu`.

Requesty zawierające `WRITE` zmieniają bazę lub TTLock. Requesty opisane jako
`WRITE TTLOCK` mogą zmienić prawdziwy zamek po ustawieniu
`TTLOCK_WRITES_ENABLED=true`; nie uruchamiaj ich w pierwszej rundzie testów.

Pierwszy kontrolowany test samego TTLock, bez rezerwacji i zapisu w naszej
bazie, znajduje się w folderze `04 TTLock — diagnostyka`. Wykonuj kolejno:

1. `WRITE TTLOCK TEST — Utwórz kod bez rezerwacji`,
2. `WRITE TTLOCK TEST — Zmień daty kodu bez rezerwacji`,
3. `WRITE TTLOCK TEST — Usuń kod bez rezerwacji`.

Pierwszy request zapisuje otrzymany `keyboardPwdId` w zmiennej
`testKeyboardPwdId`, więc dwa następne requesty użyją właściwego kodu.

Endpointy `Access Codes` wymagają wcześniejszego wykonania migracji
`migrations/005_ttlock_access_codes.sql` i poprawnego przypisania urządzeń.
Po osobno zatwierdzonym teście fizycznym głównym requestem tworzącym kod jest:

`05 Access Codes / WRITE TTLOCK — Utwórz lub pobierz kod rezerwacji (automat)`.

Request pobiera `reservationId` ze środowiska, sam wyznacza zamek i standardowe
godziny apartamentu. Nie ustawiaj ręcznie `lockId`, cyfr ani godzin przy
automatycznym tworzeniu. Request ręcznej zmiany godzin służy wyłącznie do
zatwierdzonego wcześniejszego przyjazdu lub późniejszego wyjazdu. Podfolder
`AWARYJNE / TECHNICZNE` nie jest częścią zwykłego testu automatu.

## Pierwszy bezpieczny test Hostex

Folder `06 Hostex — tylko odczyt` nie zawiera żadnych requestów zapisujących.
Przed testem utwórz w Hostex token o zakresie `read-only`, zapisz go jako
`HOSTEX_ACCESS_TOKEN` w `.env`, ustaw `HOSTEX_ENABLED=true` i zrestartuj backend.

Następnie wykonaj kolejno:

1. `Status Hostex`,
2. `Lista obiektów Hostex`,
3. `Lista rezerwacji Hostex`.

Pusta lista jest poprawnym wynikiem dla konta bez obiektów i bez połączonego
Booking.com. Skrypt drugiego requestu zapisze pierwszy znaleziony identyfikator
w `hostexPropertyId`, ale nie utworzy ani nie zmieni żadnych danych.
