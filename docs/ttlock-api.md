# TTLock API — bezpieczny klient integracji

Moduł korzysta z TTLock Cloud API V3. Odczyty są dostępne, a przygotowane
operacje zapisu kodów są domyślnie blokowane przez `TTLOCK_WRITES_ENABLED=false`.
Moduł nie udostępnia operacji otwierania, resetowania ani inicjalizowania zamka.

Wszystkie endpointy wymagają tokenu administratora Supabase:

```text
Authorization: Bearer <supabase-access-token>
```

## Endpointy

### Status konfiguracji

```http
GET /api/ttlock/status
```

Zwraca wyłącznie informację, które grupy sekretów są skonfigurowane. Nie zwraca
ich wartości.

### Lista zamków

```http
GET /api/ttlock/locks
```

Zwraca bezpieczny podzbiór danych: identyfikator, nazwę, alias, baterię,
`keyboardPwdVersion`, `specialValue`, informację o bramce oraz grupę.

Odpowiedź celowo nie zawiera m.in. `lockData`, MAC, kluczy AES, kodów
administracyjnych ani superkodu.

### Lista bramek

```http
GET /api/ttlock/gateways
```

Zwraca identyfikator bramki, wersję, liczbę zamków i stan online. Nie zwraca MAC
bramki ani nazwy sieci Wi-Fi.

### Zbiorczy ekran aplikacji

Do widoku iOS należy preferować domenowy endpoint:

```http
GET /api/access-codes/overview
```

Łączy on zamki i bramki TTLock z lokalnym przypisaniem apartamentów, stanem
kodów oraz opcjonalnymi, zagregowanymi statystykami. Niskopoziomowe endpointy
`/api/ttlock/*` pozostają przydatne do diagnostyki integracji.

### Możliwości kodów

```http
GET /api/ttlock/passcode-capabilities
```

W tym projekcie kod gościa do apartamentu ma **dokładnie 4 cyfry**. Jest to
potwierdzone zachowaniem naszych zamków w oficjalnej aplikacji TTLock.

Dokumentacja mobilnego SDK Bluetooth opisuje zakres 6–9 cyfr, ale backend nie
korzysta z tego SDK. Wykorzystuje Cloud API V3 i bramkę Wi-Fi; dokumentacja
endpointu dodawania kodu dla zamków V4 nie narzuca długości kodu. Ostatecznym
testem kompatybilności będzie kontrolowana próba na jednym zamku, wykonana
dopiero po osobnej zgodzie właściciela.

### Metadane istniejących kodów

```http
GET /api/ttlock/locks/:lockId/passcodes
```

Endpoint pobiera listę kodów z TTLock, ale celowo nie zwraca cyfr kodu ani konta
nadawcy. Zwraca tylko ID, nazwę, długość, typ, okres ważności i status. Pozwala to
zarządzać powiązaniami bez ujawniania kodów w zwykłych odpowiedziach API.

### Podgląd kodu bez zapisu

```http
POST /api/ttlock/passcodes/preview
```

Przykład:

```json
{
  "lockId": 123,
  "passcode": "0123",
  "name": "Rezerwacja testowa",
  "startAt": "2026-08-20T14:00:00+02:00",
  "endAt": "2026-08-23T10:00:00+02:00"
}
```

Podgląd wymaga dokładnie 4 cyfr (również z zerem na początku), sprawdza daty,
przynależność zamka do konta,
`keyboardPwdVersion = 4` i obecność bramki. Nie wywołuje
`/v3/keyboardPwd/add`, nie zwraca wartości kodu i zawsze zawiera:

```json
{
  "valid": true,
  "writeExecuted": false,
  "addType": 2
}
```

Publiczne operacje tworzenia, zmiany i usuwania kodów należą do warstwy
`/api/access-codes`, opisanej w `docs/access-codes-api.md`. Są zaimplementowane,
ale `TTLOCK_WRITES_ENABLED=false` blokuje je przed jakimkolwiek zapisem. Flaga
zostanie czasowo włączona dopiero po wyborze zamka testowego i osobnej zgodzie
na pierwszy fizyczny test.

### Kontrolowany test zapisu bez rezerwacji i bazy

Do jednorazowego sprawdzenia samego TTLock służą endpointy diagnostyczne:

```http
POST   /api/ttlock/diagnostic/locks/:lockId/passcodes
PATCH  /api/ttlock/diagnostic/locks/:lockId/passcodes/:keyboardPwdId
DELETE /api/ttlock/diagnostic/locks/:lockId/passcodes/:keyboardPwdId
```

Nie odczytują ani nie zapisują rezerwacji oraz nie tworzą historii w naszej
bazie. Nadal wymagają tokenu administratora i `TTLOCK_WRITES_ENABLED=true`.
Są przeznaczone wyłącznie do sekwencji: utworzenie, sprawdzenie w aplikacji i
na zamku, modyfikacja, ponowne sprawdzenie, usunięcie.

Utworzenie:

```json
{
  "passcode": "4827",
  "name": "TEST API — USUNAC",
  "startAt": "2026-09-20T15:00:00+02:00",
  "endAt": "2026-09-23T11:00:00+02:00"
}
```

Odpowiedź zwraca `keyboardPwdId`, który trzeba wykorzystać przy modyfikacji i
usunięciu. Nie zapisujemy go poza klientem wykonującym test.

Modyfikacja może zmienić daty, nazwę i opcjonalnie cyfry. `startAt` i `endAt`
muszą zostać przekazane razem:

```json
{
  "startAt": "2026-09-21T15:00:00+02:00",
  "endAt": "2026-09-24T11:00:00+02:00",
  "name": "TEST API — ZMIENIONY"
}
```

Każda odpowiedź diagnostyczna jawnie zawiera
`databaseWriteExecuted: false`. Po usunięciu kodu należy ponownie ustawić
`TTLOCK_WRITES_ENABLED=false` i zrestartować backend.

## Konfiguracja

Wymagane:

```dotenv
TTLOCK_ENABLED=true
TTLOCK_CLIENT_ID=
TTLOCK_CLIENT_SECRET=
```

Do autoryzacji trzeba ustawić jedną z dwóch konfiguracji:

```dotenv
# Konto ze zwykłej aplikacji TTLock — nie konto deweloperskie
TTLOCK_ACCOUNT_USERNAME=
TTLOCK_ACCOUNT_PASSWORD_MD5=
```

albo:

```dotenv
TTLOCK_ACCESS_TOKEN=
TTLOCK_REFRESH_TOKEN=
```

`TTLOCK_ACCOUNT_PASSWORD_MD5` jest 32-znakowym małymi literami hashem MD5.
Należy traktować go jak pełnoprawne hasło. Nie wolno go commitować ani
przesyłać na czacie.

Token jest buforowany tylko w pamięci procesu. Jeżeli TTLock zwróci błąd
wygasłego tokenu, backend jeden raz ponawia autoryzację. Trwałe szyfrowane
przechowywanie rotowanego refresh tokenu będzie osobnym etapem przed wdrożeniem
automatycznego tworzenia kodów.

## Ręczny test bez uruchamiania API

Po uzupełnieniu zmiennych można wykonać:

```bash
npm run ttlock:check
```

Polecenie odpytuje tylko listę zamków i bramek. Wynik jest oczyszczony z danych
wrażliwych.

## Oficjalna dokumentacja

- [Autoryzacja OAuth](https://euopen.ttlock.com/doc/oauth2)
- [Odświeżanie tokenu](https://euopen.ttlock.com/doc/oauth2/refreshToken)
- [`lock/list`](https://euopen.ttlock.com/doc/api/v3/lock/list)
- [`gateway/list`](https://euopen.ttlock.com/doc/api/v3/gateway/list)
- [Dodawanie własnego kodu przez Cloud API V3](https://euopen.ttlock.com/doc/api/v3/keyboardPwd/add)
- [Odmienny zakres opisany dla mobilnego SDK Bluetooth](https://euopen.ttlock.com/doc/sdk/v3/android/lockInterface)
- [Lista kodów zamka](https://euopen.ttlock.com/doc/api/v3/lock/listKeyboardPwd)
- [Rekordy zamka](https://euopen.ttlock.com/doc/api/v3/lockRecord/list)
- [Kody błędów](https://euopen.ttlock.com/doc/api/error)
