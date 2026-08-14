# Kody dostępu do apartamentów

Moduł `access-codes` jest warstwą domenową używaną przez panel administratora
i przyszłą aplikację iOS. Klient nie musi znać szczegółów TTLock.

Wszystkie endpointy mają prefiks `/api/access-codes` i wymagają tokenu
administratora zweryfikowanego przez `SupabaseAdminGuard`.

## Bezpieczne uruchomienie

Domyślnie obowiązuje:

```env
TTLOCK_WRITES_ENABLED=false
```

W tym trybie można korzystać wyłącznie z odczytów. Automatyczne utworzenie,
modyfikacja i usunięcie kodu kończą się przed zapisem TTLock. Odczyt historii
i statystyk pozostaje dostępny po wykonaniu migracji.

Przed pierwszym kontrolowanym testem trzeba:

1. wykonać kopię bazy,
2. uruchomić `migrations/005_ttlock_access_codes.sql`,
3. ustawić `ACCESS_CODE_ENCRYPTION_KEY` na 32 losowe bajty zakodowane base64,
4. przypisać dwa zamki apartamentów w `apartment_access_devices`,
5. wybrać jedną przyszłą rezerwację testową,
6. dopiero na czas testu ustawić `TTLOCK_WRITES_ENABLED=true`.

Klucza szyfrującego nie wolno zapisywać w repozytorium. Można go wygenerować
lokalnie poleceniem `openssl rand -base64 32` i umieścić wyłącznie w sekretach
środowiska backendu.

## Status

```http
GET /api/access-codes/status
```

Zwraca informację, czy skonfigurowano szyfrowanie i czy zapisy TTLock są
odblokowane. Nie zwraca sekretów.

## Historia kodów

```http
GET /api/access-codes/history?apartmentId=<uuid>&from=<ISO>&to=<ISO>&limit=50&cursor=<cursor>
```

Opcjonalne filtry: `apartmentId`, `reservationId`, `status`, `from`, `to`.
Paginacja używa nieprzezroczystego kursora zamiast `OFFSET`.
`GET /api/access-codes` jest równoważnym, krótszym aliasem.

Każda pozycja zawiera między innymi:

- apartament,
- daty pobytu,
- imię i nazwisko gościa,
- czterocyfrowy kod,
- okres ważności i stan,
- identyfikator kodu TTLock,
- zapamiętaną liczbę użyć oraz datę jej ostatniego odświeżenia,
- wersję potrzebną do bezpiecznej modyfikacji.

Odpowiedź zawiera również jednoznaczne, bezpieczne wskazanie urządzenia:

```json
{
  "accessDevice": {
    "id": "00000000-0000-4000-8000-000000000010",
    "provider": "ttlock",
    "lockId": 123,
    "displayName": "Zamek — Apartament Rynek"
  }
}
```

Dotyczy to zarówno aktywnych kodów, jak i szkiców. `lockId` jest informacją w
odpowiedzi, ale nie jest przyjmowany w żądaniu utworzenia. Backend wyznacza
zamek z `reservationId` i zapisanego przypisania apartamentu, dzięki czemu
klient iOS nie może omyłkowo wysłać kodu do innego lokalu.

Kod jest odszyfrowywany wyłącznie w chronionej odpowiedzi administratora.
W bazie znajduje się AES-256-GCM ciphertext i osobny HMAC używany do wykrywania
kolizji. Kod nie trafia do logów ani do zdarzeń audytowych.

## Automatyczne utworzenie kodu dla rezerwacji

```http
PUT /api/access-codes/by-reservation/:reservationId
```

Żądanie nie przyjmuje kodu, `lockId` ani godzin. Backend:

1. sprawdza, czy rezerwacja jest potwierdzona,
2. wybiera zamek przypisany do jej apartamentu,
3. wylicza ważność z dat pobytu oraz polityki apartamentu,
4. losuje bezpieczny czterocyfrowy kod i sprawdza kolizje lokalnie oraz w TTLock,
5. zapisuje kod przez bramkę,
6. odczytuje listę kodów zamka i potwierdza identyfikator, cyfry oraz godziny,
7. dopiero po potwierdzeniu zwraca stan `active`.

Endpoint jest idempotentny: ponowienie dla rezerwacji z aktywnym kodem zwraca
ten sam rekord i nie tworzy drugiego kodu. Kod w stanie `pending_*` albo
`sync_error` wymaga sprawdzenia i nie jest automatycznie dublowany.

Po podłączeniu Hostex ten sam serwis zostanie wywołany asynchronicznie po
zapisaniu potwierdzonej rezerwacji. Endpoint administracyjny pozostaje do
kontrolowanego testu i ręcznego wznowienia procesu.

Migracja 005 dodaje do każdego apartamentu domyślną politykę:

```text
access_code_check_in_time  = 15:00
access_code_check_out_time = 11:00
access_code_time_zone      = Europe/Warsaw
```

Wartości są konfigurowalne per apartament. Backend przelicza je z uwzględnieniem
czasu letniego i zimowego. Odpowiedź zawiera `validitySource=apartment_default`
oraz `timeZone`, dzięki czemu aplikacja rozróżnia standard od ręcznego wyjątku.

## Modyfikacja

```http
PATCH /api/access-codes/:id
Content-Type: application/json

{
  "validUntil": "2026-08-23T12:00:00+02:00",
  "expectedVersion": 1
}
```

Ten endpoint przyjmuje tylko `validFrom`, `validUntil` i `expectedVersion`.
Zmienia okres ważności bez zmiany cyfr ani nazwy kodu. Można zmienić
wyłącznie godziny w dniu przyjazdu i wyjazdu zapisanym w rezerwacji; próba
przesunięcia kodu na inny dzień jest odrzucana. Po zmianie backend ponownie
potwierdza cyfry i okres na liście kodów TTLock. Odpowiedź otrzymuje
`validitySource=manual_override`. `expectedVersion` chroni przed nadpisaniem
równoległej zmiany na innym urządzeniu.

## Awaryjna wymiana kodu na nowy

Ta ścieżka nie jest częścią standardowego automatu. Pozostaje dla sytuacji,
w której administrator świadomie chce zmienić również cyfry kodu. Nowy kod
przechodzi przez ekran potwierdzenia:

```http
POST /api/access-codes/:id/replacement-draft
Content-Type: application/json

{
  "validUntil": "2026-08-23T12:00:00+02:00",
  "expectedVersion": 1
}
```

Odpowiedź zawiera nowy czterocyfrowy szkic. iOS pokazuje go żonie, a ustawienie
w TTLock następuje dopiero przez `POST /api/access-codes/drafts/:draftId/apply`.
Do tego momentu stary kod pozostaje aktywny i niezmieniony.

## Usunięcie z zamka

```http
DELETE /api/access-codes/:id?expectedVersion=1
```

Kod jest usuwany z TTLock przez bramkę (`deleteType=2`), ale lokalny rekord
pozostaje w historii ze stanem `revoked`.

## Użycia kodu

```http
GET /api/access-codes/:id/usage
POST /api/access-codes/:id/usage/refresh
```

TTLock udostępnia rekordy otwarć. Backend pobiera je wyłącznie na żądanie,
filtruje udane otwarcia kodem (`recordType=4`, `success=1`) i nigdy nie zwraca
konta operatora ani kodu pochodzącego z surowych logów.

`GET` zwraca aktualny wynik bez modyfikowania bazy. `POST .../refresh` dodatkowo
zapisuje licznik, pierwsze i ostatnie użycie w historii, aby lista w aplikacji
nie powodowała wielu zapytań do TTLock. Nie przewidujemy odpytywania cyklicznego.

## Zbiorczy podgląd zamków

```http
GET /api/access-codes/overview
GET /api/access-codes/overview?includeStatistics=true&statisticsDays=30
```

Podstawowe wywołanie wykonuje lekki odczyt i zwraca:

- wszystkie zamki widoczne na koncie TTLock wraz z nazwą i aliasem,
- poziom baterii zgłoszony do chmury TTLock oraz prostą kategorię
  `good`, `low`, `critical` lub `unknown`,
- informację, czy zamek ma bramkę, oraz wersję obsługi kodów,
- lokalne przypisanie zamka do apartamentu lub wspólnego wejścia,
- liczbę bieżących i przyszłych kodów oraz błędów synchronizacji,
- zbiorczy stan bramek online/offline.

Statystyki są wyłączone domyślnie. Po ustawieniu `includeStatistics=true`
backend pobiera rekordy na żądanie i dla każdego zamka agreguje liczbę
udanych otwarć, udanych otwarć kodem, nieprawidłowych prób kodu i czas ostatniej
aktywności. Zakres wynosi domyślnie 30 dni i może mieć maksymalnie 180 dni.
Surowe logi, kody i nazwy kont TTLock nie opuszczają serwisu integracyjnego.

Oficjalna dokumentacja endpointu rekordów pozwala podać zakres dat, ale nie
gwarantuje okresu przechowywania historii. Dlatego odpowiedź jawnie zawiera
`providerRetentionGuaranteed: false`. Flaga `complete` oznacza wyłącznie, że
nie osiągnięto naszego limitu paginacji; nie dowodzi kompletności archiwum po
stronie TTLock. Jeżeli statystyki mają kiedyś obejmować okres dłuższy niż
historia dostawcy, trzeba będzie przechowywać lokalne agregaty.

## Odporność na częściowe błędy

PostgreSQL i TTLock nie współdzielą jednej transakcji. Dlatego przed operacją
zewnętrzną rekord otrzymuje stan `pending_*`. Jeśli odpowiedź TTLock jest
niejednoznaczna albo połączenie zostanie przerwane, rekord przechodzi do
`sync_error` i zachowuje opis błędu do ręcznej weryfikacji. Historia nie jest
wtedy kasowana ani automatycznie ponawiana.

## Źródła TTLock

- [Dodawanie kodu](https://euopen.ttlock.com/doc/api/v3/keyboardPwd/add)
- [Modyfikacja kodu](https://euopen.ttlock.com/doc/api/v3/keyboardPwd/change)
- [Usuwanie kodu](https://euopen.ttlock.com/doc/api/v3/keyboardPwd/delete)
- [Rekordy otwarć](https://euopen.ttlock.com/doc/api/v3/lockRecord/list)
