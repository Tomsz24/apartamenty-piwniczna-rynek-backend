# Plan działania: rezerwacje, Hostex i TTLock

Stan na: **2026-08-14**

Projekt: backend NestJS dla Apartamentów Piwniczna-Zdrój Rynek

## Legenda

- [x] wykonane
- [ ] do wykonania

Checkbox oznaczamy jako wykonany dopiero po sprawdzeniu rezultatu. Samo napisanie
kodu nie oznacza jeszcze wdrożenia go na produkcji.

## Cel i docelowy przepływ

System ma obsługiwać dwa apartamenty i zdejmować z właścicieli powtarzalne
obowiązki: odbieranie i aktualizowanie rezerwacji, zarządzanie dostępnością,
cenami i minimalną liczbą nocy oraz tworzenie kodów do zamków.

Docelowo:

```text
Booking.com <-> Hostex <-> NestJS <-> aplikacja iOS / panel ekipy sprzątającej
                              |
                              +----> Supabase
                              |
                              +----> TTLock Open Platform <-> bramki <-> zamki
```

Po podłączeniu Hostex źródłem zmian cen, dostępności i ograniczeń powinien być
Hostex, obsługiwany przez nasz backend i aplikację. Zdjęcia, opisy i część danych
oferty nadal mogą wymagać Booking Extranetu. Dokładny podział trzeba potwierdzić
na jednym apartamencie przed pełnym uruchomieniem.

## Zasady bezpieczeństwa

- [ ] Nie wykonywać migracji produkcyjnej bez aktualnej kopii bazy i próby jej
  odtworzenia.
- [ ] Nie wdrażać backendu korzystającego z nowych tabel przed wykonaniem i
  zweryfikowaniem migracji.
- [ ] Nie podłączać obu apartamentów do Hostex jednocześnie. Najpierw wdrożenie
  kontrolne na jednym apartamencie.
- [ ] Nie uruchamiać połączenia Booking–Hostex w środku sezonu bez gotowego
  planu aktywacji i wycofania zmian.
- [ ] Nigdy nie umieszczać tokenów Hostex, `clientSecret` TTLock, haseł, kodów do
  drzwi ani kluczy Supabase w repozytorium, logach lub wiadomościach.
- [ ] Wszystkie operacje zewnętrzne projektować jako idempotentne, z audytem,
  kontrolowanymi ponowieniami i możliwością ręcznej naprawy.
- [ ] Aplikacja iOS i panel webowy korzystają z NestJS; nie otrzymują kluczy
  administracyjnych Supabase, Hostex ani TTLock.
- [ ] Dla cen wprowadzić twardą blokadę wartości `0` oraz rozsądne limity
  minimalne i maksymalne przed pierwszym zapisem do Hostex.

---

## 1. Dostosowanie bazy danych i modelu rezerwacji

### 1.1. Wykonane podstawy

- [x] Utworzyć wspólny model `reservations` ze stabilnym wewnętrznym UUID.
- [x] Utworzyć model aliasów źródłowych `reservation_source_refs`, aby zmiana UID
  iCal nie powodowała utraty powiązań.
- [x] Utworzyć `orphaned_reservation_notes` do odzyskiwania starych notatek.
- [x] Przygotować migrację `migrations/001_unified_reservations.sql` bez usuwania
  tabel legacy.
- [x] Zaimplementować moduł `src/reservations/`, CRUD administratora, walidację,
  wykrywanie kolizji terminów, blokady transakcyjne i `expectedVersion`.
- [x] Zachować zgodność starych endpointów `/api/calendars`.
- [x] Zmienić iCal tak, aby nie usuwał rezerwacji, przechowywał historię UID i
  kierował niejednoznaczne przypadki do `needs_review`.
- [x] Sprawdzić produkcyjny schemat Supabase wyłącznie w trybie odczytu.
- [x] Porównać produkcyjny schemat i dane z pierwszą migracją.
- [x] Potwierdzić oczekiwany wynik migracji dla obecnego stanu: 9 rezerwacji,
  9 referencji źródłowych i 51 osieroconych notatek.
- [x] Dodać osobną migrację indeksu ręcznie przypisywanych osieroconych notatek.
- [x] Przygotować lokalnie fundament powiadomień: urządzenia, zdarzenia i próby
  dostarczenia. Migracja nie została jeszcze wykonana na produkcji.

### 1.2. Poprawienie pierwszej migracji przed jej użyciem

- [x] Dodać RLS do `reservations`, `reservation_source_refs` i
  `orphaned_reservation_notes`.
- [ ] Pozostawić brak polityk dla `anon` i `authenticated`, dopóki dostęp odbywa
  się wyłącznie przez zabezpieczony backend.
- [ ] Sprawdzić ustawienia ekspozycji Data API oraz jawne `GRANT`/`REVOKE` dla
  nowych tabel; RLS i uprawnienia do Data API potraktować jako dwie osobne
  warstwy zabezpieczeń.
- [x] Zachować oryginalne `created_at` z `bookings_external`, `bookings_manual` i
  `external_booking_notes` zamiast zastępować je czasem synchronizacji.
- [x] Dodać brakujące ograniczenie `CHECK` dla
  `orphaned_reservation_notes.source_system`.
- [ ] Zaktualizować `docs/reservation-source-strategy.md` oraz migrację 003.
  Zostały przygotowane pod importer maili Booking, ale po analizie prawdziwych
  wiadomości z Booking ten kierunek został porzucony na rzecz Hostex.
- [ ] Ustalić docelowe wartości `origin` i `source_system` przed migracją:
  zachować lub usunąć niewykorzystane `booking_email` oraz dodać źródło Hostex
  bez uzależniania domeny od szczegółów Booking.
- [ ] Ponownie przejrzeć klucze obce, indeksy, unikalności i zachowanie
  `ON DELETE`.
- [ ] Dodać testy migracji dla ponownego uruchomienia, konfliktu UUID, pustych
  danych legacy oraz niejednoznacznych notatek.

### 1.3. Tabele potrzebne integracjom

Nazwy są robocze. Ostateczny schemat zatwierdzamy po obejrzeniu prawdziwych
payloadów Hostex i odpowiedzi TTLock.

- [ ] Zaprojektować mapowanie `apartment_id` na identyfikatory Hostex:
  `property_id`, listing Booking i ewentualny rate plan.
- [ ] Zaprojektować mapowanie `apartment_id` na `lockId` i `gatewayId` TTLock.
- [ ] Dodać inbox webhooków, np. `integration_webhook_events`, zawierający
  identyfikator/deduplikację, typ, bezpieczny payload, czas odbioru, stan
  przetwarzania, liczbę prób i ostatni błąd.
- [ ] Dodać stan synchronizacji, np. `integration_sync_state` lub
  `integration_sync_runs`, z kursorem, ostatnim sukcesem i błędem.
- [ ] Dodać kolejkę/outbox zadań, np. `automation_jobs`, dla przetwarzania
  webhooków, uzgadniania danych, tworzenia kodów i ponowień po awarii.
- [ ] Dodać powiązanie rezerwacji z kodem TTLock, zawierające zewnętrzny ID kodu,
  okres ważności, stan operacji i historię zmian.
- [ ] Ustalić, czy kod drzwi musi być przechowywany. Jeżeli tak, szyfrować go
  aplikacyjnie kluczem spoza bazy, nigdy go nie logować i usuwać po ustalonym
  okresie retencji.
- [ ] Dodać audyt ważnych operacji: zmiana ceny, minimalnej liczby nocy,
  dostępności, anulowanie rezerwacji, utworzenie/usunięcie kodu i zdalne
  otwarcie zamka, jeśli zostanie udostępnione.
- [ ] Włączyć RLS i sprawdzić uprawnienia Data API dla każdej nowej tabeli.
- [ ] Dodać ograniczenia deduplikujące identyfikatory Hostex, webhooki i aktywne
  kody TTLock.

### 1.4. Próba i wdrożenie migracji

- [ ] Przygotować osobną bazę testową lub bezpieczną kopię aktualnego schematu i
  danych zanonimizowanych.
- [ ] Uruchomić wszystkie migracje na bazie testowej.
- [ ] Sprawdzić liczbę rekordów, ograniczenia, indeksy, RLS i uprawnienia.
- [ ] Przetestować stare i nowe endpointy backendu na bazie testowej.
- [ ] Uruchomić testy, build i `git diff --check`.
- [ ] Uruchomić Supabase security/performance advisors i rozwiązać uwagi dotyczące
  naszych tabel.
- [ ] Wykonać pełną kopię produkcyjnej bazy oraz próbę odtworzenia.
- [ ] Uzyskać osobne potwierdzenie właściciela przed zapisem do produkcyjnego
  Supabase.
- [ ] Wykonać migrację produkcyjną.
- [ ] Zweryfikować wynik migracji i dopiero później wdrożyć nowy backend.
- [ ] Skonfigurować regularny eksport/kopię bazy niezależną od darmowego planu
  Supabase.

Warunek zakończenia etapu: nowy model działa na produkcji, dane legacy są
zachowane, RLS i uprawnienia zostały sprawdzone, a kopia może zostać odtworzona.

---

## 2. Implementacja integracji Hostex

### 2.1. Ustalenia przed podłączeniem Booking.com

- [ ] Założyć/skonfigurować konto Hostex dla dwóch apartamentów, ale jeszcze nie
  łączyć aktywnych ofert Booking.com.
- [ ] Potwierdzić z Hostex, że wybrany plan obejmuje potrzebne OpenAPI i webhooki
  dla obu apartamentów.
- [ ] Uzyskać token API i umieścić go wyłącznie w sekretach środowiska.
- [ ] Potwierdzić z dokumentacją lub wsparciem Hostex:
  - kierunek synchronizacji rezerwacji, cen, dostępności i ograniczeń,
  - sposób oznaczania modyfikacji i anulowania rezerwacji,
  - zakres danych gościa dostępny przez API,
  - zachowanie podczas pierwszego połączenia z Booking,
  - sposób potwierdzania zakończenia asynchronicznych zapisów,
  - możliwość bezpiecznego testu bez publikowania błędnych cen.
- [ ] Spisać prostą instrukcję dla rodziny: co nadal zmienia się w Extranecie
  (np. zdjęcia/opisy), a co wyłącznie w naszej aplikacji/Hostex
  (ceny, dostępność, restrykcje).
- [ ] Ustalić jedno źródło prawdy dla cen, dostępności i minimalnej liczby nocy,
  aby Booking, Hostex i nasz backend nie nadpisywały się w pętli.

### 2.2. Klient Hostex i mapowanie danych

- [ ] Utworzyć osobny `HostexModule` i klienta API ukrytego za interfejsem
  dostawcy, aby domena rezerwacji nie zależała bezpośrednio od Hostex.
- [ ] Dodać timeouty, ograniczone retry z backoffem, obsługę `429`, błędów 5xx i
  bezpieczne logowanie bez tokenów i danych osobowych.
- [ ] Pobrać listę properties/listings i przypisać każdy identyfikator do
  właściwego `apartment_id`.
- [ ] Zapisać oraz ręcznie zweryfikować mapowanie apartamentu, oferty Booking i
  rate planu przed zezwoleniem na jakikolwiek zapis.
- [ ] Zmapować statusy Hostex na nasze `confirmed`, `cancelled`, `needs_review`
  itd.; nieznane statusy kierować do ręcznej weryfikacji.
- [ ] Ustalić obsługę strefy czasowej i semantykę `endDate` jako dnia wyjazdu.
- [ ] Dodać testy kontraktowe oparte na zanonimizowanych prawdziwych odpowiedziach
  Hostex.

### 2.3. Import i aktualizacja rezerwacji

- [ ] Zaimplementować początkowy import rezerwacji z Hostex bez tworzenia
  duplikatów istniejących wpisów iCal.
- [ ] Powiązać `reservation_code`, `stay_code` i identyfikatory Booking przez
  `reservation_source_refs`.
- [ ] Zdefiniować bezpieczne reguły scalania rezerwacji Hostex z istniejącymi
  rezerwacjami iCal; przypadki niejednoznaczne oznaczać `needs_review`.
- [ ] Zaimplementować aktualizację terminu, danych gościa i statusu.
- [ ] Zaimplementować anulowanie logiczne bez kasowania historii.
- [ ] Zaimplementować tworzenie rezerwacji ręcznej z naszej aplikacji przez
  Hostex oraz zapis otrzymanych identyfikatorów.
- [ ] Zaimplementować zmianę i anulowanie rezerwacji ręcznej oraz ochronę
  `expectedVersion` przed równoległymi edycjami.
- [ ] Wyłączyć iCal jako główne źródło dopiero po potwierdzeniu stabilności
  Hostex; początkowo pozostawić go jako awaryjną kontrolę tylko do odczytu.

### 2.4. Webhooki i uzgadnianie danych

- [ ] Udostępnić HTTPS endpoint webhooków na VPS.
- [ ] Weryfikować nagłówek `Hostex-Webhook-Secret-Token` i odrzucać niepoprawne
  żądania.
- [ ] Zapisać zdarzenie do inboxa i odpowiedzieć `200` w czasie krótszym niż
  3 sekundy; właściwe przetwarzanie wykonać asynchronicznie.
- [ ] Obsłużyć co najmniej `reservation_created` i `reservation_updated`.
- [ ] Obsłużyć `property_availability_updated` i `listing_calendar_updated`, gdy
  włączymy zarządzanie kalendarzem.
- [ ] Ignorować nieznane pola payloadu i bezpiecznie rejestrować nieznany typ
  zdarzenia zamiast odrzucać cały webhook.
- [ ] Deduplikować webhooki i zabezpieczyć przetwarzanie przed równoległym
  wykonaniem.
- [ ] Po webhooku pobierać pełny aktualny obiekt z API, ponieważ payload webhooka
  może zawierać tylko identyfikatory zdarzenia.
- [ ] Dodać okresowe uzgadnianie rezerwacji i kalendarza, ponieważ Hostex nie
  ponawia webhooka, jeśli nie otrzyma odpowiedzi w wymaganym czasie.
- [ ] Dodać ręczny endpoint administracyjny „synchronizuj teraz”.
- [ ] Dodać alert po trwałym błędzie, rosnącej kolejce lub zbyt dawnej udanej
  synchronizacji.
- [ ] W pierwszym etapie komunikacji udostępnić najwyżej podgląd ostatnich
  wiadomości z rozmowy Hostex powiązanej z rezerwacją. Nie budować jeszcze
  pełnego czatu ani wysyłania odpowiedzi z naszej aplikacji.
- [ ] Wysyłkę SMS pozostawić na sam koniec projektu i uruchomić dopiero po
  osobnej decyzji właścicieli o dodatkowym płatnym dostawcy.

### 2.5. Ceny, dostępność i ograniczenia

- [ ] Dodać do backendu operacje odczytu aktualnych cen, dostępności i
  ograniczeń dla obu apartamentów.
- [ ] Dodać endpointy używane przez aplikację iOS do zmiany ceny, dostępności i
  minimalnej liczby nocy.
- [ ] Dodać walidację zakresu dat, cen i liczby nocy oraz dodatkowe potwierdzenie
  dla zmian masowych.
- [ ] Zablokować cenę `0`, wartości ujemne i wartości poza ustalonym zakresem.
- [ ] Zaimplementować zapis do właściwej oferty/rate planu, a nie tylko ogólnej
  dostępności obiektu.
- [ ] Po każdej zmianie odczytać stan ponownie lub obsłużyć potwierdzenie zadania,
  ponieważ odpowiedź `200` może oznaczać tylko przyjęcie operacji asynchronicznej.
- [ ] Pokazać użytkownikowi stan `oczekuje`, `potwierdzono` albo `błąd`, zamiast
  udawać, że każda zmiana natychmiast dotarła do Booking.
- [ ] Zapisywać autora, poprzednią i nową wartość w audycie.
- [ ] Przetestować ochronę przed pętlą: nasz zapis -> webhook Hostex -> brak
  ponownego identycznego zapisu.

### 2.6. Testy i kontrolowane podłączenie produkcji

- [ ] Przetestować klienta i webhooki bez połączenia z aktywną ofertą Booking.
- [ ] Przetestować: nową rezerwację, zmianę terminu/liczby gości, anulowanie,
  utracony webhook, duplikat webhooka i czasową awarię Hostex.
- [ ] Przed podłączeniem zapisać eksport/zrzuty konfiguracji Booking: przyszłe
  rezerwacje, ceny, dostępność, minimalne pobyty, ograniczenia i rate plany.
- [ ] Przygotować checklistę wycofania połączenia oraz awaryjnej ręcznej obsługi.
- [ ] Wybrać spokojne okno serwisowe i pierwszy apartament testowy.
- [ ] Skonfigurować w Hostex ceny, dostępność i restrykcje przed ponownym
  otwarciem sprzedaży.
- [ ] Potwierdzić ręcznie, że żadna data nie ma ceny `0`, liczba dostępnych pokoi
  jest poprawna, a wszystkie przyszłe rezerwacje istnieją.
- [ ] Wykonać kontrolną rezerwację/zmianę, jeśli można to zrobić bez kosztu i
  ryzyka dla gości.
- [ ] Obserwować pierwszy apartament przez ustalony okres, np. 48–72 godziny.
- [ ] Dopiero po bezbłędnej obserwacji podłączyć drugi apartament i powtórzyć całą
  checklistę.

Warunek zakończenia etapu: rezerwacje i zmiany kalendarza są automatycznie
uzgadniane, błędy są widoczne, a cena/dostępność nie mogą zostać przypadkowo
opublikowane z niebezpieczną wartością.

---

## 3. Implementacja modułu TTLock

### 3.1. Konto i aplikacja deweloperska

- [x] Założyć darmowe konto TTLock Open Platform EU.
- [x] Potwierdzić limit 30 000 zapytań miesięcznie jako wystarczający dla trzech
  zamków i dwóch bramek bez częstego odpytywania historii.
- [x] Utworzyć aplikację deweloperską i wysłać ją do review.
- [x] Otrzymać akceptację aplikacji.
- [x] Po akceptacji odebrać `clientId` i `clientSecret` oraz umieścić je wyłącznie
  w sekretach środowiska.

### 3.2. Połączenie istniejących zamków

- [x] Potwierdzić aktualny oficjalny sposób autoryzacji istniejącego konta
  właściciela TTLock.
- [x] Uzyskać pierwszy access/refresh token dla konta właściciela i wykonać
  rzeczywisty test tylko do odczytu.
- [x] Zaimplementować automatyczne odświeżanie tokenu przed wygaśnięciem.
- [ ] Dodać alarm po trwałej utracie autoryzacji TTLock.
- [x] Wywołać wyłącznie `lock/list` dla istniejącego konta; nie inicjalizować,
  nie resetować i nie usuwać zamków.
- [x] Dla trzech zamków odczytać `lockId`, nazwę, `keyboardPwdVersion`, poziom
  baterii, `specialValue` i `hasGateway`.
- [ ] Zapisać mapowanie: wspólne drzwi wejściowe oraz zamek właściwy dla każdego
  z dwóch apartamentów.
- [x] Pobrać listę dwóch bramek i potwierdzić, że obie są online.
- [ ] Potwierdzić powiązanie każdego zamka z właściwą bramką oraz jakość sygnału
  RSSI.
- [ ] Potwierdzić strefę czasową, model, firmware i możliwości zamka.
- [ ] Nigdy nie logować odpowiedzi zawierających `lockData`, klucze AES,
  `adminPwd`, superkod lub inne dane administracyjne zamka.
- [x] Potwierdzić `keyboardPwdVersion = 4` dla wszystkich trzech zamków.
- [x] Ustalić wymaganie biznesowe: kod gościa do apartamentu ma dokładnie
      4 cyfry; nasze zamki obsługują takie kody w aplikacji TTLock.
- [x] Rozdzielić ograniczenie mobilnego SDK Bluetooth (6–9 cyfr) od Cloud API
      V3 używanego przez backend, które nie dokumentuje minimalnej długości.
- [ ] Po osobnej zgodzie wykonać kontrolowany test czterocyfrowego kodu przez
      bramkę na jednym zamku apartamentu i natychmiast potwierdzić rezultat.
- [x] Przygotować bezpieczny odczyt metadanych kodów bez ujawniania ich wartości.
- [x] Przygotować walidację i podgląd czasowego kodu bez wykonywania zapisu.
- [ ] Potwierdzić przez API obsługę zdalnego dodawania własnych kodów przez
  bramkę. Obecne zdalne tworzenie kodów w aplikacji TTLock jest dobrym sygnałem,
  ale test API jest wymagany.

### 3.3. Klient TTLock w NestJS

- [x] Utworzyć osobny `TtlockModule` i klienta Cloud API V3.
- [x] Obsłużyć format `application/x-www-form-urlencoded`, wymagane znaczniki
  czasu w milisekundach oraz błąd rozbieżności zegara serwera.
- [x] Dodać timeouty, pojedyncze kontrolowane ponowienie autoryzacji i mapowanie
  kodów błędów.
- [ ] Dodać lokalny limit zapytań przed udostępnieniem kolejnych operacji TTLock.
- [x] Redagować tokeny, hasła i kody dostępu ze wszystkich logów i raportów.
- [x] Dodać endpoint administracyjny statusu integracji bez ujawniania sekretów.
- [x] Dodać bezpieczny ręczny test połączenia oraz odczyt baterii/bramki na
  żądanie.

### 3.4. Automatyczne kody do rezerwacji

- [x] Przygotować migrację `005_ttlock_access_codes.sql` z mapowaniem zamków,
  konfigurowalnymi godzinami apartamentów, szyfrowaną historią i szkicami
  awaryjnymi, stanem synchronizacji, statystykami oraz audytem.
- [ ] Wykonać kopię bazy i dopiero potem uruchomić migrację 005.
- [ ] Ustawić w sekretach `ACCESS_CODE_ENCRYPTION_KEY` i zachować jego kopię
  poza repozytorium; utrata klucza uniemożliwi odczyt zapisanych kodów.
- [ ] Przypisać dwa zamki apartamentów do rekordów `apartments`; wspólne drzwi
  wejściowe zachować jako urządzenie `shared_entrance` ze stałym kodem.
- [x] Ustalić moment utworzenia kodu: bezpośrednio po zapisaniu potwierdzonej
  rezerwacji z Hostex. Wysłanie instrukcji gościowi pozostaje osobnym zadaniem
  uruchamianym w dniu przyjazdu.
- [x] Ustalić godziny ważności kodu: domyślnie `15:00` w dniu przyjazdu do
  `11:00` w dniu wyjazdu, konfigurowalne per apartament i przeliczane w strefie
  `Europe/Warsaw` z uwzględnieniem czasu letniego/zimowego.
- [x] Przygotować utworzenie własnego czasowego kodu przez bramkę, domyślnie
  zablokowane przez `TTLOCK_WRITES_ENABLED=false` do czasu testu fizycznego.
- [x] Dodać główną, jednoetapową i idempotentną operację automatyczną po
  `reservationId`; backend sam wybiera zamek i godziny. Szkice pozostawić jako
  awaryjny mechanizm świadomej wymiany cyfr kodu, a nie standardowy flow.
- [x] Zapewnić, że ponowienie automatycznej operacji zwraca ten sam aktywny kod,
  a nie tworzy kolejnego.
- [x] Generować nieprzewidywalne kody zgodne z ograniczeniami zamka i nie używać
  łatwych schematów opartych na numerze rezerwacji lub dacie.
- [x] Zapisać zewnętrzny identyfikator kodu, okres ważności i stan operacji przy
  rezerwacji.
- [x] Po utworzeniu potwierdzić kod przez listę kodów zamka, zamiast polegać
  wyłącznie na odpowiedzi pierwszego żądania.
- [x] Zapewnić idempotencję: ponowienie zadania nie może tworzyć kolejnych kodów
  dla tej samej rezerwacji.
- [x] Przygotować ręczną zmianę wyłącznie godzin ważności kodu w dniu przyjazdu
  i wyjazdu; zachować te same cyfry, ponownie potwierdzić stan w TTLock i
  oznaczyć zmianę jako `manual_override`.
- [x] Przygotować ręczne usunięcie/unieważnienie kodu z zachowaniem lokalnej
  historii; automatyczne powiązanie z anulowaniem rezerwacji pozostaje osobnym
  krokiem.
- [ ] Obsłużyć wyścig: modyfikacja lub anulowanie podczas tworzenia/wysyłania
  kodu.
- [ ] Dodać ponowienia i alert, jeśli bramka jest offline albo operacja kończy
  się błędem.
- [x] Dodać możliwość ręcznego zastąpienia i unieważnienia kodu przez
  administratora.
- [ ] Przygotować dalszy punkt integracji z wysyłką wiadomości do gościa oraz
  zapisem, kiedy i komu kod został wysłany.

### 3.5. Historia i funkcje opcjonalne

- [x] Dodać pobieranie historii otwarć wyłącznie na żądanie administratora oraz
  opcjonalne zapisanie licznika użyć w lokalnej historii.
- [x] Nie odpytywać TTLock co kilka minut i nie dublować standardowych
  powiadomień aplikacji TTLock.
- [ ] Opcjonalnie dodać rzadki odczyt baterii i stanu bramki, np. raz dziennie,
  tylko jeśli okaże się użyteczny.
- [ ] Zdalne otwarcie z naszej aplikacji traktować jako funkcję późniejszą:
  wymaga ponownego potwierdzenia użytkownika, mocnej autoryzacji i pełnego
  audytu.

### 3.6. Testy fizyczne i procedura awaryjna

- [ ] Testować na jednym zamku w czasie, gdy apartament nie jest zajęty.
- [ ] Utworzyć kod przez API, sprawdzić go fizycznie i potwierdzić początek oraz
  koniec ważności.
- [ ] Przetestować zmianę terminu, usunięcie kodu i ponowienie tej samej operacji.
- [ ] Przetestować kod po utracie internetu/bramki; potwierdzić, że wcześniej
  zapisany kod nadal działa lokalnie w zamku.
- [ ] Przetestować zachowanie po zmianie czasu letni/zimowy i skontrolować zegar
  zamka.
- [ ] Sprawdzić alert niskiego poziomu baterii i niedostępnej bramki.
- [ ] Sprawdzić historię otwarć na żądanie bez stałego pollingu.
- [ ] Przygotować awaryjny kod administracyjny/klucz mechaniczny i instrukcję dla
  właścicieli na wypadek awarii automatyzacji.
- [ ] Dopiero po pełnym teście jednego zamka skonfigurować dwa pozostałe, w tym
  wspólne drzwi wejściowe.

Warunek zakończenia etapu: dla prawdziwej rezerwacji można niezawodnie utworzyć,
potwierdzić, zmienić i usunąć kod, a awaria bramki lub API prowadzi do alarmu i
jasnej procedury ręcznej.

---

## Prace przekrojowe i odbiór całości

- [ ] Dodać testy jednostkowe mapowań Hostex i TTLock.
- [ ] Dodać testy integracyjne z atrapami obu dostawców, w tym timeouty,
  duplikaty, nieznane pola i błędy częściowe.
- [ ] Dodać test pełnego przepływu: nowa rezerwacja -> zapis -> kod TTLock ->
  modyfikacja -> zmiana kodu -> anulowanie -> usunięcie kodu.
- [ ] Zapewnić obserwowalność: identyfikator korelacji, stan kolejki, ostatnia
  udana synchronizacja i alarmy bez danych osobowych lub kodów.
- [ ] Dodać endpoint health-check dla bazy oraz bezpieczny status Hostex/TTLock.
- [ ] Spisać krótkie instrukcje operacyjne dla właścicieli i ekipy sprzątającej.
- [ ] Spisać procedurę awarii Hostex, TTLock, Supabase i VPS.
- [ ] Wdrożyć najpierw backend i tryb tylko do odczytu, następnie Hostex na jednym
  apartamencie, a automatyczne zapisy i kody włączać osobnymi flagami.
- [ ] Po okresie stabilizacji usunąć niepotrzebne ścieżki iCal/legacy dopiero po
  wykonaniu archiwum i osobnej decyzji.

## Najbliższa kolejność prac

1. [ ] Zaktualizować strategię źródeł i migrację 003: usunąć nieaktualne
   założenie, że maile Booking są źródłem prawdy, oraz uwzględnić Hostex.
2. [ ] Zaprojektować i dodać migrację tabel integracyjnych, webhook inbox,
   kolejkę/outbox, mapowania dostawców i kody TTLock.
3. [ ] Przetestować cały schemat na bazie testowej; nie zapisywać jeszcze do
   produkcyjnego Supabase.
4. [ ] Uruchomić dostęp do Hostex API bez łączenia aktywnych ofert Booking i
   zebrać prawdziwe zanonimizowane odpowiedzi/payloady.
5. [ ] Zaimplementować klienta Hostex, import, webhooki i uzgadnianie danych.
6. [x] Uzupełnić autoryzację konta właściciela TTLock i odczytać listę
   istniejących zamków oraz ich możliwości bez resetowania urządzeń.
7. [ ] Zaimplementować i fizycznie przetestować kody TTLock na jednym zamku.
8. [ ] Wykonać kopię, migrację i wdrożenie backendu.
9. [ ] Podłączyć Hostex do jednego apartamentu według checklisty kontrolnej.
10. [ ] Po okresie obserwacji uruchomić drugi apartament i automatyzację kodów.

## Dokumentacja dostawców do weryfikacji przy implementacji

- [Hostex OpenAPI — webhook usage guide](https://hostex-openapi.readme.io/reference/webhook-useage-guide)
- [Hostex OpenAPI — webhook payload examples](https://hostex-openapi.readme.io/reference/webhook-payload-examples)
- [TTLock Open Platform EU — Cloud API V3](https://euopen.ttlock.com/doc/api)
- [Supabase changelog — breaking changes](https://supabase.com/changelog?types=breaking-change)

Dokumentacja zewnętrzna może się zmieniać. Przed implementacją każdego endpointu
trzeba ponownie sprawdzić aktualny kontrakt w oficjalnej dokumentacji.
