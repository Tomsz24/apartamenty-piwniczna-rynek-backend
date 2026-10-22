# Powiadomienia e-mail o rezerwacjach

Usługa: [Resend](https://resend.com). Darmowy plan: 3000 wiadomości miesięcznie,
100 dziennie (sprawdzone 21.10.2026; [cennik](https://resend.com/pricing)).
Nadawca: `Apartamenty Piwniczna Rynek <rezerwacje@apartamenty-piwniczna-rynek.pl>`.
Odbiorca testowy: `tomaszwojciechowski244@gmail.com`. Nie wysyłamy do gościa.

## Konfiguracja domeny w home.pl

1. Załóż konto Resend, wybierz plan Free.
2. W Domains dodaj dokładnie `apartamenty-piwniczna-rynek.pl` (bez `https://`).
   Wybierz dostępny region europejski. Włącz wysyłanie.
3. Skopiuj z Resend wszystkie rekordy weryfikacji i wysyłania — typ, nazwę,
   wartość oraz priorytet, jeśli występuje. Są zależne od konta/regionu;
   nie wpisuj kluczy DKIM ani adresów serwerów z przypadkowego przykładu.
4. W panelu home.pl otwórz domenę i jej rekordy DNS. Dodaj rekordy pokazane przez
   Resend. Jeśli domena korzysta z zewnętrznych serwerów DNS, zmiany wprowadź
   u operatora tych serwerów. Sprawdź, czy panel dopisuje końcówkę domeny do
   nazwy rekordu — nie powielaj jej.
5. Zachowaj istniejące rekordy strony i poczty. Rekordów return-path, np. pod
   `send`, nie przenoś na domenę główną. Nie włączaj odbierania poczty w Resend
   ani nie zmieniaj głównych MX, jeśli potrzebujesz tylko tych powiadomień.
6. W Resend uruchom weryfikację i poczekaj na status Verified.
   DMARC skonfiguruj po sprawdzeniu istniejących wpisów; nie twórz drugiego
   rekordu DMARC ani drugiego SPF pod tą samą nazwą.
7. Utwórz klucz API z uprawnieniem wysyłania, ograniczony do tej domeny.
   Zapisz go w sekretach hostingu lub lokalnym `.env`; nie commituj klucza.

Samo wysyłanie z wybranej nazwy nie wymaga wykupienia skrzynki w home.pl.
Odbieranie odpowiedzi na `rezerwacje@...` wymaga osobnej konfiguracji poczty.

Źródła: [domeny Resend](https://resend.com/docs/dashboard/domains/introduction),
[rekordy DNS home.pl](https://pomoc.home.pl/baza-wiedzy/rekordy-domeny).

## Uruchomienie

1. Wykonaj migrację `20261021144218_reservation_email_outbox.sql` po migracjach
   001–014. Jest wygenerowana przez CLI Supabase i umieszczona w istniejącym
   katalogu ręcznie wykonywanych migracji projektu. Nie wykonuje wysyłki.
2. Ustaw:

```dotenv
RESERVATION_EMAIL_ENABLED=true
RESEND_API_KEY=UZUPELNIJ_SEKRET
RESERVATION_EMAIL_FROM=rezerwacje@apartamenty-piwniczna-rynek.pl
RESERVATION_EMAIL_TO=tomaszwojciechowski244@gmail.com
RESERVATION_EMAIL_START_AT=UZUPELNIJ_DATE_ROZPOCZECIA_TESTOW_ISO_8601
```

`START_AT` jest stałym momentem uruchomienia, np. `2026-10-21T19:00:00+02:00`.
Nie przesuwaj go przy każdym restarcie: odciąłbyś oczekujące zdarzenia.
Starsze zdarzenia są pomijane, co zapobiega wysłaniu całej historii przy
pierwszym włączeniu. Zdarzenia od tego momentu są wysyłane także po restarcie.
Backend korzysta z jednego `.env`; szczegóły w `environment.md`.

3. Uruchom backend. Błędna lub niepełna konfiguracja aktywnej wysyłki zatrzyma start.
4. Na uzgodnionej rezerwacji testowej sprawdź utworzenie, zmianę dat/liczby gości,
   następnie anuluj ją. Oczekuj trzech maili na testowym Gmailu. Worker przetwarza
   jeden e-mail co 30 sekund na instancję backendu. Blokada właścicielska nie
   generuje wiadomości. Sprawdź też folder Spam.
5. Po testach zmień `RESERVATION_EMAIL_TO` i zrestartuj backend. Można podać
   kilka adresów po przecinku (maks. 10); każdy dostaje osobny mail (wysyłka
   zbiorcza Resend w jednym żądaniu z kluczem idempotencji) i nie widzi
   pozostałych odbiorców. Wiadomości,
   których wysyłanie już rozpoczęto, zachowują poprzedniego odbiorcę dla
   bezpiecznego ponawiania. Najpierw opróżnij/sprawdź kolejkę testową.

## Zachowanie i niezawodność

Trigger na `reservations` zapisuje e-mail w tej samej transakcji co zmiana
rezerwacji: Hostex, edycje lokalne i źródło booking_email. Rollback usuwa też
zdarzenie. Nowe importowane pobyty historyczne/anulowane, blokady właścicielskie
oraz źródło booking_ical nie generują nowych maili. Import iCal został wycofany.
Pierwszy import przyszłych aktywnych rezerwacji po starcie generuje powiadomienia.
Aktualizacje znaczników synchronizacji, metadata i wersji nie są zmianami pobytu.
Zmiana notatki, danych gościa, ceny, płatności lub statusu jest zmianą pobytu.
Anulowanie oznacza przejście statusu na `cancelled`; fizyczny DELETE nie jest obsługiwany.
Każdy mail czeka 90 sekund przed wysyłką. Zmiany z tego czasu trafiają do maila,
który jeszcze nie wyszedł: nowa rezerwacja z notatką dopisaną chwilę później daje
jeden mail, a kilka szybkich edycji daje jeden mail „zmieniono” z różnicą obejmującą
wszystkie zmiany. Rezerwacja utworzona i anulowana w tym oknie nie wysyła nic, a
zmiany już anulowanej rezerwacji (np. wyzerowana cena z Hostex) nie wysyłają maila.
Nie są wysyłane kody dostępu ani surowe dane dostawców.

Kolejka jest niezależna od skrzynki powiadomień w aplikacji i preferencji push.
Przechowuje migawkę danych w momencie zdarzenia oraz dokładny request pierwszej
próby. RLS i odebrane uprawnienia blokują dostęp `anon` / `authenticated`.
Worker korzysta z istniejącego uprzywilejowanego połączenia `PG_POOL`.

Blokady wierszy i `SKIP LOCKED` koordynują instancje. Trwała dzierżawa dwóch minut
pozwala wznowić pracę po awarii procesu. Resend otrzymuje stały `Idempotency-Key`.
HTTP 429, 408, 5xx i błędy sieci ponawiamy z opóźnieniem (do 12 prób); pozostałe
błędy HTTP wymagają poprawy konfiguracji. Po 23 godzinach od pierwszej próby
wymagana jest ręczna weryfikacja, ponieważ Resend pamięta klucze tylko przez
24 godziny. Nie gwarantujemy automatycznej wysyłki po długiej awarii lub
wyczerpaniu dziennego/miesięcznego limitu — sprawdź wtedy kolejkę.

`sent` oznacza przyjęcie przez Resend, a nie potwierdzone dostarczenie do Gmaila.
Odbicia/spam sprawdzaj w panelu Resend; webhooki dostarczalności nie są wdrożone.

```sql
SELECT id, event_type, status, attempts, last_error, created_at, sent_at
FROM reservation_email_outbox ORDER BY created_at DESC LIMIT 100;
```

Przed ręcznym ponowieniem sprawdź w Resend, czy wiadomość dotarła. Nie zeruj
`first_attempt_at` ani nie zmieniaj zapisanego requestu dla niepewnej wysyłki.
`failed` wymaga reakcji administratora; backend zapisuje ostrzeżenie z ID zdarzenia.
Wiersze zawierają dane osobowe. Ustal retencję; przykładowo usuwaj wysłane starsze
niż 90 dni oraz nigdy nierozpoczęte zdarzenia sprzed `START_AT`, po ich sprawdzeniu.

## Podglądy i testy

```sh
npm test
node scripts/preview-reservation-emails.js
```

HTML w `docs/email-previews/` używa fikcyjnych danych i tego samego szablonu co
wysyłka. Układ tabelkowy, style inline i wersja tekstowa obsługują klientów poczty.
Ostateczny wygląd i dostarczalność należy jeszcze sprawdzić w docelowym Gmailu.

Opcjonalny test prawdziwego silnika PostgreSQL uruchamia migrację w PGlite,
bez połączenia z bazą projektu. Po instalacji `@electric-sql/pglite` w osobnym
katalogu ustaw `PGLITE_MODULE` na ścieżkę modułu i uruchom:

```sh
node --test test/reservation-email-database.spec.js
```
