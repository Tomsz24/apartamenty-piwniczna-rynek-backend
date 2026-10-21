# Strategia źródeł rezerwacji

## Zasada nadrzędna

System nie traktuje pliku iCal jako źródła prawdy o rezerwacjach.

Docelowy podział odpowiedzialności:

- `hostex` - źródło prawdy dla rezerwacji z kanałów obsługiwanych przez Hostex,
- `manual` - starsze lub lokalne rezerwacje administratora, które nie mają
  powiązania z Hostex; nowe rezerwacje z aplikacji zapisują się najpierw w
  Hostex,
- `booking_ical` - wyłącznie archiwum starych wpisów. Import iCal jest usunięty;
  stare wpisy nie są aktywnymi rezerwacjami.

Hostex jest nadrzędnym źródłem danych dla wszystkich rzeczywistych rezerwacji.
Tabela `reservations` jest lokalnym widokiem/cache'em Hostex rozszerzonym o dane
aplikacji, które nie pochodzą z Hostex, takie jak notatki, wiek dzieci i
powiązania z kodami TTLock. `stay_code` w `reservation_source_refs` wiąże lokalne
rozszerzenia z pobytem w Hostex.

## Dlaczego iCal nie jest rezerwacją

iCal opisuje zajętość terminu, a nie pełną tożsamość rezerwacji. Booking.com może
zmieniać UID wpisu albo pokazać kilka pobytów jako jeden ciągły blok. Dlatego UID
iCal nie może być właścicielem notatek, liczby gości ani statusu rezerwacji.

Stabilną tożsamością zawsze jest `reservations.id`.

## Nowy przepływ

1. Backend pobiera rezerwacje z Hostex OpenAPI.
2. `hostex_property_mappings` przypisuje Hostex `property_id` do lokalnego
   `apartments.id`; import nie działa dla nieprzypisanych obiektów.
3. `stay_code` trafia do `reservation_source_refs` jako stabilny identyfikator
   źródłowy (`source_system = 'hostex'`). `reservation_code` i kanał są
   zachowywane jako metadane.
4. Import tworzy/aktualizuje `reservations` z `origin = 'hostex'`. Jeden
   dokładny stary wpis iCal może zostać przejęty, aby zachować UUID i notatkę;
   pozostałe wpisy iCal pozostają archiwalne i nie blokują pobytów Hostex.
5. Kolizje z aktywnymi rezerwacjami `hostex` lub `manual` są pomijane i trafiają
   do `reservation_review_items`.
   Nieznany status Hostex trafia do `needs_review`.
6. Rezerwacja dodana z aplikacji jest najpierw tworzona w Hostex jako Direct
   przez kanał `Mobile App`, a następnie importowana do `reservations` jako
   `origin = 'hostex'` i wiązana przez `stay_code`. Notatki i wiek dzieci są
   dopisywane lokalnie. Historyczne rekordy `manual` pozostają lokalnymi
   rezerwacjami i nie są automatycznie wysyłane do Hostex.
7. Backend nie pobiera już iCal. Historyczne obserwacje pozostają w bazie.

Standardowe endpointy rezerwacji i kalendarze pokazują tylko `manual` oraz
`hostex`. Dawne rekordy iCal pozostają w bazie wraz z notatkami i można je
tymczasowo obejrzeć przez `GET /api/reservations?includeLegacy=true`. Nie
kasujemy ich automatycznie ani nie traktujemy jako dostępności Hostex.

## Powiadomienia

Powiadomienia korzystają z kolejki zdarzeń:

- `notification_devices` - urządzenia administratorów i tokeny push,
- `notification_events` - zdarzenia do wysłania,
- `notification_deliveries` - próby dostarczenia na konkretne urządzenia.

Aplikacja iOS będzie wysyłać token APNs do backendu po rejestracji urządzenia.
Backend zapisze token w `notification_devices`, a osobny worker lub zadanie
cykliczne będzie wysyłać zdarzenia z `notification_events` przez APNs.
