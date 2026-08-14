# Migracje bazy danych

Migracje są wykonywane ręcznie w kolejności numerów przed wdrożeniem wersji backendu,
która z nich korzysta. Każdy plik jest przygotowany tak, aby nie usuwać tabel legacy.

Pierwsza migracja tworzy wspólny model rezerwacji i kopiuje dane z
`bookings_manual`, `bookings_external` oraz `external_booking_notes`.

Druga migracja dodaje brakujący indeks dla ręcznego przypisywania osieroconych
notatek.

Trzecia migracja podporządkowuje bazę nowej strategii źródeł:

- maile Booking.com są przyszłym źródłem prawdy dla rezerwacji,
- ręczne wpisy w panelu są źródłem prawdy dla blokad i notatek,
- iCal jest wyłącznie obserwacją zajętości i trafia do osobnych tabel.

Czwarta migracja dodaje fundament pod powiadomienia push i inne alerty:

- urządzenia administratorów,
- zdarzenia powiadomień,
- próby dostarczenia na konkretne urządzenia.

Piąta migracja przygotowuje integrację kodów dostępu TTLock:

- domyślne godziny `15:00`–`11:00` i strefę `Europe/Warsaw`, konfigurowalne
  osobno dla każdego apartamentu,
- mapowanie zamków na apartamenty i wspólne wejście,
- zaszyfrowaną historię kodów powiązaną z rezerwacjami,
- zaszyfrowane, wygasające szkice używane wyłącznie przy awaryjnej wymianie
  cyfr kodu przed zapisem do TTLock,
- stan synchronizacji, statystyki użycia i dziennik operacji,
- RLS oraz odebranie bezpośredniego dostępu rolom `anon` i `authenticated`.

Przed uruchomieniem na produkcji:

1. wykonaj kopię bazy,
2. uruchom migrację najpierw na bazie testowej,
3. sprawdź liczbę rekordów w `reservations` i `orphaned_reservation_notes`,
4. dopiero potem wdróż nową wersję backendu.
