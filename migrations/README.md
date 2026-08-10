# Migracje bazy danych

Migracje są wykonywane ręcznie w kolejności numerów przed wdrożeniem wersji backendu,
która z nich korzysta. Każdy plik jest przygotowany tak, aby nie usuwać tabel legacy.

Pierwsza migracja tworzy wspólny model rezerwacji i kopiuje dane z
`bookings_manual`, `bookings_external` oraz `external_booking_notes`.

Przed uruchomieniem na produkcji:

1. wykonaj kopię bazy,
2. uruchom migrację najpierw na bazie testowej,
3. sprawdź liczbę rekordów w `reservations` i `orphaned_reservation_notes`,
4. dopiero potem wdróż nową wersję backendu.
