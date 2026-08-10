# Strategia źródeł rezerwacji

## Zasada nadrzędna

System nie traktuje pliku iCal jako źródła prawdy o rezerwacjach.

Docelowy podział odpowiedzialności:

- `booking_email` - źródło prawdy dla rezerwacji Booking.com, zmian i anulacji,
- `manual` - źródło prawdy dla ręcznych rezerwacji, blokad i notatek dodanych w panelu,
- `booking_ical` - pasywna obserwacja zajętości kalendarza Booking.com.

## Dlaczego iCal nie jest rezerwacją

iCal opisuje zajętość terminu, a nie pełną tożsamość rezerwacji. Booking.com może
zmieniać UID wpisu albo pokazać kilka pobytów jako jeden ciągły blok. Dlatego UID
iCal nie może być właścicielem notatek, liczby gości ani statusu rezerwacji.

Stabilną tożsamością zawsze jest `reservations.id`.

## Nowy przepływ

1. Importer maili Booking.com zapisuje wiadomość w `booking_email_messages`.
2. Po rozpoznaniu numeru rezerwacji Booking.com importer tworzy lub aktualizuje
   rekord w `reservations` z `origin = 'booking_email'`.
3. Numer rezerwacji Booking.com trafia do `reservation_source_refs` jako
   `source_system = 'booking_email'`.
4. Ręczne pobyty lub blokady dodane w panelu trafiają do `reservations` jako
   `origin = 'manual'`.
5. Synchronizacja iCal zapisuje zajętość do `ical_availability_observations`.
6. Dopasowania między blokami iCal a rezerwacjami trafiają do
   `ical_observation_reservation_matches`.
7. Niezgodności trafiają do `reservation_review_items`.

## Przykład złączonych bloków iCal

Jeżeli iCal pokazuje jeden blok:

```text
2026-08-10 -> 2026-08-15
```

a system ma dwie rezerwacje z maili:

```text
2026-08-10 -> 2026-08-12
2026-08-12 -> 2026-08-15
```

to obserwacja iCal otrzymuje `match_status = 'matched_multiple'`. Nie powstaje
fałszywa jedna rezerwacja, a notatki pozostają przypięte do właściwych rekordów
`reservations`.

## Powiadomienia

Powiadomienia korzystają z kolejki zdarzeń:

- `notification_devices` - urządzenia administratorów i tokeny push,
- `notification_events` - zdarzenia do wysłania,
- `notification_deliveries` - próby dostarczenia na konkretne urządzenia.

Aplikacja iOS będzie wysyłać token APNs do backendu po rejestracji urządzenia.
Backend zapisze token w `notification_devices`, a osobny worker lub zadanie
cykliczne będzie wysyłać zdarzenia z `notification_events` przez APNs.
