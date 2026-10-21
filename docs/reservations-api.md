# API rezerwacji

Wszystkie endpointy `/api/reservations` wymagają nagłówka
`Authorization: Bearer <supabase-access-token>` i uprawnienia administratora.

Daty są przesyłane jako `YYYY-MM-DD`. `endDate` oznacza dzień wyjazdu i nie jest
zajętym noclegiem, dlatego rezerwacja kończąca się 12 sierpnia nie koliduje z
rezerwacją rozpoczynającą się 12 sierpnia.

## Lista

`GET /api/reservations`

Opcjonalne parametry: `apartmentId`, `from`, `to`, `status`,
`includeCancelled=true`, `includeLegacy=true`. Domyślnie zwracane są wyłącznie
rezerwacje lokalne (`manual`) i zsynchronizowane z Hostex (`hostex`); dawne
wpisy iCal są ukryte, ale zachowane w bazie. `includeLegacy=true` służy do ich
kontroli. Domyślnie anulowane rezerwacje również nie są zwracane.

Rezerwacje Hostex mogą dodatkowo zawierać `guestPhone`, `guestEmail`, `adults`,
`children`, `infants`, `pets`, `totalRateAmount`, `amountReceived`, `currency`,
`paymentStatus` i `channelType`. Pola finansowe są opcjonalne, bo zależą od
danych zwróconych przez Hostex. `amountReceived` nie jest gwarantowanym
rozliczeniem wszystkich wpływów; pewne zestawienie wymaga osobnej synchronizacji
transakcji Hostex. Wiek dzieci (`childAges`) i notatki (`note`) pozostają
danymi lokalnymi.

## Cena rezerwacji ręcznej

Aplikacja iOS wylicza cenę na bieżąco według polityki cenowej z Booking.com
(640 zł dla 4 pełnopłatnych osób, rabaty zależne od obłożenia i stawki dziecięce)
i pozwala administratorowi skorygować cenę dla konkretnej rezerwacji. Rezerwacja
musi zawierać od 1 do 4 gości, przynajmniej jednego dorosłego oraz końcowe
`totalRateAmount`. Backend nie przelicza polityki cenowej — zapisuje otrzymaną
kwotę i wysyła ją do Hostex. `amountReceived` pozostaje opcjonalne i domyślnie
wynosi 0 zł; wpłata nie może przekraczać podanej ceny całkowitej.

## Szczegóły

`GET /api/reservations/:id`

## Utworzenie ręcznej rezerwacji

`POST /api/reservations`

```json
{
  "apartmentId": "00000000-0000-0000-0000-000000000000",
  "clientReservationId": "b6831a51-1a3c-40b7-932f-a9f5404b77cc",
  "startDate": "2026-08-20",
  "endDate": "2026-08-23",
  "status": "confirmed",
  "guestName": "Jan Kowalski",
  "guestCount": 3,
  "adults": 2,
  "children": 1,
  "childAges": [7],
  "guestPhone": "+48123123123",
  "guestEmail": "jan@example.com",
  "note": "Przygotować dostawkę",
  "totalRateAmount": 1250.50,
  "amountReceived": 500.00
}
```

`clientReservationId` powinien być stabilnym UUID szkicu z aplikacji. Backend
przekształca go na alfanumeryczny identyfikator Hostex `channel_id`, aby ponowne
wysłanie żądania po timeout nie tworzyło duplikatu. Aplikacja iOS przekazuje
UUID szkicu automatycznie.

`childAges` jest opcjonalne. Jeśli podajesz wiek, liczba wartości musi zgadzać
się z `children`; wiek przyjmujemy w latach od 0 do 17. Dane kontaktowe i wiek
dzieci wymagają migracji `007_reservation_guest_details.sql`.
Kwota otrzymana domyślnie wynosi 0 zł. Rezerwacja jest wysyłana do Hostex jako bezpośrednia,
przez kanał `Mobile App`, w PLN, z prowizją 0 zł i metodą płatności `Cash`.
Backend pobiera ID tych pozycji ze słowników Hostex. Wpłata nie może przekraczać
kwoty całkowitej.

Backend odrzuca termin nachodzący na aktywną rezerwację tego apartamentu.
Przy `HOSTEX_WRITES_ENABLED=false` nowe rezerwacje są odrzucane — backend nie
zapisuje ich lokalnie jako pozornie zsynchronizowanych. Po włączeniu zapisów
Hostex backend najpierw tworzy rezerwację bezpośrednią w Hostex, odczytuje ją
ponownie i wiąże z lokalnym rekordem. Tworzenie z aplikacji obsługuje status
`confirmed`; `blocked` i `tentative` wymagają osobnej obsługi po stronie Hostex.

## Edycja

`PATCH /api/reservations/:id`

Wysyłamy tylko zmieniane pola. Warto przekazać `expectedVersion` z ostatnio
pobranej rezerwacji, aby aplikacja nie nadpisała nowszej zmiany wykonanej na
innym urządzeniu.

```json
{
  "guestCount": 4,
  "adults": 2,
  "children": 2,
  "note": "Cztery komplety ręczników",
  "expectedVersion": 1
}
```

Dla rezerwacji Hostex zmiany dat i danych gościa są wysyłane do Hostex przed
lokalnym zapisem. Wiek dzieci i notatka pozostają lokalne. Rezerwację Hostex
można anulować z aplikacji tylko wtedy, gdy jest to rezerwacja bezpośrednia;
rezerwacje kanałów OTA trzeba anulować w ich źródle.
Można też przekazać `arrivalMessageSentAt` jako znacznik czasu po ręcznym
potwierdzeniu wysłania wiadomości z kodem i mapką, albo `null`, aby cofnąć
potwierdzenie. Powitanie pozostaje zarządzane przez automatyzację Booking.com.
Status w aplikacji nie wysyła wiadomości do Hostex ani SMS-em.

## Anulowanie ręcznej rezerwacji

`DELETE /api/reservations/:id`

Zwraca `204`. Rekord nie jest fizycznie kasowany; otrzymuje status `cancelled`.

## Osierocone notatki

- `GET /api/reservations/orphaned-notes`
- `POST /api/reservations/:reservationId/orphaned-notes/:noteId/attach`

Przypisanie zachowuje istniejącą treść notatki na rezerwacji i dołącza do niej
treść odzyskaną z dawnego UID iCal.

## Zgodność ze starym frontendem

Dotychczasowe endpointy pozostają aktywne i korzystają już z nowego modelu:

- `GET /api/calendars`
- `POST /api/calendars/bookings`
- `PUT /api/calendars/bookings/:id`
- `DELETE /api/calendars/bookings/:id`
