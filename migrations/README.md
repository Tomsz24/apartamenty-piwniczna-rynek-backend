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

Szósta migracja dodaje źródło rezerwacji Hostex oraz tabelę przypisań
`hostex_property_mappings`. Import Hostex wymaga najpierw przypisania każdego
`property_id` do właściwego apartamentu. Wstępne przypisanie dwóch znanych
properties jest wstawiane na podstawie adresu Rynek 3 i nazw apartamentów;
należy je sprawdzić przez endpoint mapowań. Podgląd synchronizacji jest bez
zapisu, a zapis wykonuje osobny endpoint administratora.

Siódma migracja dodaje dane kontaktowe gościa oraz opcjonalne wieki dzieci do
rezerwacji. Dane te są edytowane przez administratora; integracja Hostex
uzupełnia je wyłącznie wtedy, gdy źródło faktycznie zwraca takie informacje.

Ósma migracja dodaje lekkie podsumowanie danych Hostex do rezerwacji: liczbę
niemowląt i zwierząt, cenę całkowitą, walutę, opcjonalną kwotę otrzymaną, jeśli
Hostex ją zwraca, oraz status płatności. Nie zapisuje listy gości, dokumentów
ani pełnego payloadu finansowego.

Dziewiąta migracja dodała znaczniki czasu dla statusów wiadomości. Aplikacja
korzysta z pola statusu wiadomości z dnia przyjazdu; powitanie pozostaje
zarządzane przez automatyzację Booking.com. `NULL` oznacza, że administrator
nie oznaczył wiadomości przyjazdowej jako wysłanej.

Dziesiąta migracja ustawia ważność standardowych kodów TTLock od 12:00 w dniu
przyjazdu do 11:00 w dniu wyjazdu w strefie `Europe/Warsaw`. Backend tworzy
kody automatycznie w dniu przyjazdu, dostosowuje ich okres po zmianie dat
rezerwacji i usuwa je z TTLock po anulowaniu rezerwacji.

Jedenasta migracja zapisuje osobne szablony wiadomości przyjazdowej dla
apartamentu z widokiem na góry i apartamentu z widokiem na rynek. Kody dostępu
i daty ważności są placeholderami do uzupełnienia przy przygotowaniu wiadomości;
mapka wskazuje wspólny plik `apartments-map.jpg` w buckecie
`arrival-message-assets`. Tabela ma włączone RLS i nie jest dostępna
bezpośrednio dla ról `anon` ani `authenticated`.

Przed uruchomieniem na produkcji:

1. wykonaj kopię bazy,
2. uruchom migrację najpierw na bazie testowej,
3. sprawdź liczbę rekordów w `reservations` i `orphaned_reservation_notes`,
4. dopiero potem wdróż nową wersję backendu.

Migracja 009 dodaje wyłącznie dwa nullable znaczniki czasu do tabeli
`reservations`; nie zmienia istniejących rezerwacji ani integracji Hostex.

Dwunasta migracja dodaje preferencje powiadomień push administratora. Tokeny
urządzeń są zapisywane w tabeli `notification_devices` z migracji 004, a
preferencje są dostępne wyłącznie przez backend po autoryzacji administratora.

Czternasta migracja dodaje per-administratorowy stan przeczytania zdarzeń
powiadomień. Skrzynka powiadomień korzysta z `notification_events` z migracji
004, a status przeczytania jest przechowywany osobno dla każdego administratora.

Migracja `20261021144218_reservation_email_outbox.sql` (po 014) dodaje kolejkę
powiadomień e-mail i trigger dla zmian rezerwacji. Nie wysyła wiadomości sama;
worker wymaga jawnego włączenia oraz daty początku. Konfiguracja Resend/home.pl,
testy i obsługa błędów: `docs/reservation-emails.md`.

Migracja `20261021160000_hostex_webhook_events.sql` dodaje inbox webhooków
Hostex z deduplikacją po `event_id`, stanem przetwarzania i liczbą prób. Tabela
przechowuje tylko identyfikatory, ma włączone RLS i nie jest dostępna dla ról
`anon` ani `authenticated`. Opis: `docs/hostex-api.md`.

Migracja `20261021170000_revoke_public_table_grants.sql` odbiera rolom
`anon` i `authenticated` (Data API Supabase) domyślne uprawnienia do wszystkich
tabel w `public` oraz do tabel tworzonych później przez `postgres`. Dane i tak
były ukryte przez RLS bez polityk, więc zmiana nie wpływa na działanie backendu,
logowanie ani Storage; usuwa jedynie uprawnienia, których RLS nie obejmuje
(np. `TRUNCATE`). Wszystkie odczyty i zapisy idą przez backend.

Migracja `20261021180000_notification_event_producers.sql` dodaje typy
`access_code_error` i `arrival_message_reminder`, triggery tworzące zdarzenia
powiadomień przy nowej, zmienionej i anulowanej rezerwacji oraz przy błędzie
kodu TTLock, a także kolumnę `conversation_id` w inboxie webhooków. Błąd przy
tworzeniu powiadomienia nigdy nie blokuje zapisu rezerwacji. Opis:
`docs/notifications-api.md`.
