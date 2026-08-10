# API rezerwacji

Wszystkie endpointy `/api/reservations` wymagają nagłówka
`Authorization: Bearer <supabase-access-token>` i uprawnienia administratora.

Daty są przesyłane jako `YYYY-MM-DD`. `endDate` oznacza dzień wyjazdu i nie jest
zajętym noclegiem, dlatego rezerwacja kończąca się 12 sierpnia nie koliduje z
rezerwacją rozpoczynającą się 12 sierpnia.

## Lista

`GET /api/reservations`

Opcjonalne parametry: `apartmentId`, `from`, `to`, `status`,
`includeCancelled=true`. Domyślnie anulowane rezerwacje nie są zwracane.

## Szczegóły

`GET /api/reservations/:id`

## Utworzenie ręcznej rezerwacji

`POST /api/reservations`

```json
{
  "apartmentId": "00000000-0000-0000-0000-000000000000",
  "startDate": "2026-08-20",
  "endDate": "2026-08-23",
  "status": "confirmed",
  "guestName": "Jan Kowalski",
  "guestCount": 3,
  "adults": 2,
  "children": 1,
  "note": "Przygotować dostawkę"
}
```

Dozwolone statusy nowej rezerwacji ręcznej: `confirmed`, `tentative`, `blocked`.
Backend odrzuca termin nachodzący na aktywną rezerwację tego apartamentu.

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

Dla rezerwacji Booking administrator może edytować dane gości i notatkę. Daty
oraz status są chronione i będą zmieniane przez import wiadomości e-mail.

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
