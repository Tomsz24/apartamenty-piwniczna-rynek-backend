# Checklista pierwszego połączenia Booking.com z Hostex

Stan instrukcji: **2026-08-14**

Ta checklista dotyczy produkcyjnego podłączenia dwóch apartamentów Apartamenty
Piwniczna-Zdrój Rynek. Nie służy do implementacji backendu. Ma przeprowadzić
właścicieli przez migrację konta Booking.com do Hostex bez utraty kontroli nad
cenami, dostępnością i istniejącymi rezerwacjami.

## Najważniejsza odpowiedź przed rozpoczęciem

Nie da się przygotować w Hostex całego kalendarza Booking.com i oczekiwać, że po
połączeniu nic się nie zmieni.

Według aktualnej instrukcji Hostex po połączeniu oferty Booking.com:

- wcześniejsze ceny i dostępność tej oferty są resetowane do `0`,
- kalendarz Booking.com zostaje zablokowany, aby Booking i Hostex nie
  nadpisywały się wzajemnie,
- plany cenowe Booking.com są dopiero wtedy wczytywane do Hostex i trzeba je
  przypisać do właściwego apartamentu lub typu pokoju,
- ceny dla całego sprzedawanego okresu trzeba ustawić w kalendarzu cen Hostex,
- Booking.com może później weryfikować nowe ceny przed ponownym otwarciem
  sprzedaży.

Reset do `0` nie powinien oznaczać sprzedaży noclegu za `0`. Oferta ma być w tym
czasie zamknięta. Realnym ryzykiem jest przerwa w sprzedaży, błędne przypisanie
planu cenowego albo ponowne otwarcie tylko części terminów.

Dlatego przed połączeniem przygotowujemy kompletną kopię ustawień oraz gotową
matrycę cen. Właściwe ceny wprowadzamy **bezpośrednio po połączeniu**, już do
zaimportowanych planów cenowych Booking.com w Hostex.

## Ważne ograniczenie istniejących rezerwacji

Rezerwacje utworzone w Booking.com przed połączeniem mogą być widoczne w Hostex
tylko jako podstawowe lub ręczne wpisy. Nie należy zakładać, że późniejsza
zmiana albo anulowanie takiej rezerwacji automatycznie zaktualizuje się w
Hostex.

Do dnia wyjazdu ostatniej rezerwacji sprzed połączenia trzeba utrzymywać osobną
listę kontrolną i sprawdzać jej status również w Booking Extranecie. Nowe
rezerwacje utworzone po prawidłowym połączeniu powinny być synchronizowane przez
channel manager i będą właściwym materiałem do testu naszej integracji API.

## Dane organizacyjne migracji

Wypełnić przed rozpoczęciem:

- [ ] Data i godzina planowanego połączenia: `____________________________`
- [ ] Osoba wykonująca połączenie: `______________________________________`
- [ ] Druga osoba sprawdzająca mapowanie i ceny: `_________________________`
- [ ] Numer kontaktu do wsparcia Hostex: `________________________________`
- [ ] Numer kontaktu do wsparcia Booking.com: `___________________________`
- [ ] Początek sprzedawanego okresu: `____________________________________`
- [ ] Koniec sprzedawanego okresu: `______________________________________`
- [ ] Strefa czasowa potwierdzona jako `Europe/Warsaw`
- [ ] Waluta potwierdzona jako `PLN`

### Identyfikatory i mapowanie

| Element | Apartament 1 | Apartament 2 |
|---|---|---|
| Pełna nazwa używana przez właścicieli |  |  |
| Hostex `property_id` | `12761007` | `12761008` |
| Nazwa property w Hostex |  |  |
| Booking.com Hotel ID |  |  |
| Booking.com Room ID / nazwa pokoju |  |  |
| Maksymalna liczba gości |  |  |
| Podstawowy plan cenowy |  |  |
| Zależne plany cenowe |  |  |

Jeżeli oba apartamenty mają ten sam Booking.com Hotel ID, autoryzacja może
wczytać oba pokoje i wszystkie ich plany cenowe jednocześnie. Wtedy nie wolno
zakładać, że da się wykonać pełne wdrożenie tylko jednego apartamentu. Najpierw
trzeba potwierdzić zakres połączenia na ekranie mapowania albo ze wsparciem
Hostex.

## Warunki STOP

Nie rozpoczynać połączenia, jeżeli choć jeden z poniższych punktów jest
niezałatwiony:

- [ ] Nie znamy Hotel ID oraz Room ID obu apartamentów.
- [ ] Nie wiemy, czy apartamenty są pod jednym, czy dwoma Hotel ID.
- [ ] Nie mamy eksportu wszystkich przyszłych rezerwacji.
- [ ] Nie mamy kopii cen i ograniczeń dla całego sprzedawanego okresu.
- [ ] Nie wiemy, który plan cenowy jest podstawowy, a które są od niego zależne.
- [ ] Nie mamy czasu na ustawienie i sprawdzenie cen bezpośrednio po połączeniu.
- [ ] Nie mamy drugiej osoby, która sprawdzi mapowanie apartamentów i ceny.
- [ ] W Hostex widnieje błędna waluta, strefa czasowa, pojemność lub nazwa
  apartamentu.
- [ ] Nie działa logowanie do Booking Extranetu albo Hostex.
- [ ] Nie mamy możliwości skontaktowania się ze wsparciem Hostex i Booking.com.

## Etap A — przygotowanie kilka dni przed połączeniem

### A1. Konto i properties Hostex

- [ ] Aktywny plan obejmuje **2 properties** i dostęp do OpenAPI.
- [ ] `Property #1` i `Property #2` mają jednoznaczne, prawdziwe nazwy.
- [ ] Każdy property reprezentuje dokładnie jeden fizycznie wynajmowany
  apartament.
- [ ] Potwierdzono adres, walutę, strefę czasową, pojemność i liczbę łóżek.
- [ ] Nie utworzono przypadkiem trzeciego, zdublowanego property.
- [ ] Zapisano obecne identyfikatory Hostex z tabeli powyżej.
- [ ] Token API nadal działa w trybie tylko do odczytu.

### A2. Zakres połączenia Booking.com

- [ ] Zapisano Hotel ID widoczne w Extranecie.
- [ ] Zapisano nazwy i Room ID obu pokoi/apartamentów.
- [ ] Potwierdzono, czy jeden Hotel ID obejmuje oba apartamenty.
- [ ] Spisano wszystkie aktywne plany cenowe dla każdego pokoju.
- [ ] Oznaczono plan podstawowy, np. Standard Rate.
- [ ] Spisano zależności: plan bezzwrotny, elastyczny, tygodniowy, miesięczny,
  promocje mobilne i inne.
- [ ] Sprawdzono, czy któryś plan nie jest nieaktywny albo przeznaczony do
  usunięcia.
- [ ] Nie tworzymy nowych zależnych planów cenowych w trakcie migracji.

### A3. Kopia przyszłych rezerwacji

Wyeksportować z Booking.com wszystkie rezerwacje, których wyjazd przypada po
dniu połączenia. Plik zawiera dane osobowe, dlatego przechowywać go prywatnie,
poza repozytorium.

Dla każdej rezerwacji zachować co najmniej:

- [ ] numer rezerwacji Booking.com,
- [ ] status,
- [ ] właściwy apartament/pokój,
- [ ] datę przyjazdu i wyjazdu,
- [ ] liczbę gości,
- [ ] imię i nazwisko gościa,
- [ ] cenę i walutę,
- [ ] uwagi o wcześniejszym przyjeździe lub późniejszym wyjeździe,
- [ ] informacje potrzebne do obsługi płatności,
- [ ] datę ostatniej zmiany.

Kontrola eksportu:

- [ ] Liczba przyszłych rezerwacji w eksporcie: `__________________________`
- [ ] Najpóźniejsza data wyjazdu rezerwacji sprzed połączenia: `____________`
- [ ] Zapisano zrzuty kalendarza miesięcznego dla całego zajętego okresu.
- [ ] Zapisano ręczne blokady, pobyty właścicieli i terminy techniczne.
- [ ] Nie kopiowano danych osobowych do repozytorium, Postmana ani komunikatora.

### A4. Kopia cen, dostępności i ograniczeń

Dane trzeba zachować dla **całego okresu aktualnie otwartego do sprzedaży**, nie
tylko dla najbliższego miesiąca.

Dla każdego apartamentu i planu cenowego zapisać:

- [ ] ceny dzień po dniu albo wszystkie przedziały ze wspólną ceną,
- [ ] ceny weekendowe i sezonowe,
- [ ] wyjątki: święta, ferie, wakacje, Sylwester i wydarzenia lokalne,
- [ ] minimalną liczbę nocy,
- [ ] maksymalną liczbę nocy, jeżeli jest używana,
- [ ] minimalne i maksymalne wyprzedzenie rezerwacji,
- [ ] `closed on arrival` i `closed on departure`, jeżeli są używane,
- [ ] zamknięte terminy i ręczne blokady,
- [ ] reguły liczby gości lub dopłaty za dodatkowe osoby,
- [ ] zależności i procenty planów pochodnych,
- [ ] promocje mobilne, krajowe, Genius i inne rabaty,
- [ ] podatki, opłaty, polityki anulowania i płatności,
- [ ] godziny zameldowania i wymeldowania.

Zrzuty ekranu są kopią awaryjną, ale do szybkiego odtworzenia cen potrzebna jest
również prosta tabela lub arkusz z przedziałami dat i kwotami.

### A5. Matryca do odtworzenia cen po połączeniu

Wypełnić osobno dla każdego apartamentu. Dodać tyle wierszy, ile potrzeba.

| Apartament | Plan | Od | Do | Dni tygodnia | Cena PLN | Min. nocy | Uwagi |
|---|---|---|---|---|---:|---:|---|
|  | Standard |  |  |  |  |  |  |
|  | Standard |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |

Zależne plany:

| Apartament | Plan zależny | Plan bazowy | Różnica/procent | Czy aktywny? |
|---|---|---|---:|---|
|  |  |  |  |  |

### A6. Rezerwacje sprzed połączenia — lista kontrolna

Nie wpisywać danych gości do tego pliku w repozytorium. Prowadzić osobną,
prywatną tabelę operacyjną.

- [ ] Utworzono listę wszystkich rezerwacji sprzed połączenia.
- [ ] Każdy wiersz zawiera numer Booking, apartament, termin i status.
- [ ] Wyznaczono osobę sprawdzającą anulowania i zmiany w Extranecie.
- [ ] Ustalono codzienną kontrolę do wyjazdu ostatniej starej rezerwacji.
- [ ] Ustalono sposób ręcznego odzwierciedlenia zmiany/anulowania w Hostex.
- [ ] Ustalono, że nie tworzymy automatycznie kodu TTLock dla niepewnego lub
  zdublowanego wpisu bez sprawdzenia numeru rezerwacji.

## Etap B — przygotowanie okna serwisowego

- [ ] Wybrano spokojny dzień i kilka godzin bez innych obowiązków.
- [ ] W tym czasie nikt inny nie zmienia cen ani kalendarza w Extranecie.
- [ ] Nie trwa pilna obsługa przyjazdu lub wyjazdu gościa.
- [ ] Otwarty jest Hostex, Booking Extranet, matryca cen i eksport rezerwacji.
- [ ] Wykonano świeże zrzuty cen, kalendarza i listy rezerwacji.
- [ ] Zapisano godzinę ostatniego poprawnego stanu przed połączeniem.
- [ ] Druga osoba jest dostępna do niezależnego sprawdzenia.

## Etap C — połączenie i mapowanie

Wykonywać kolejno. Nie przechodzić dalej po błędzie lub niejednoznacznym
mapowaniu.

- [ ] W Booking.com otwarto ustawienia dostawcy connectivity.
- [ ] Wybrano i autoryzowano Hostex dla właściwego Hotel ID.
- [ ] W Hostex: `Connected Accounts` → `Connect an account` → `Booking.com`.
- [ ] Wprowadzono właściwy login i Hotel ID.
- [ ] Poczekano na pełne wczytanie pokoi i wszystkich planów cenowych.
- [ ] Zanotowano liczbę wczytanych pokoi/listings: `________________________`
- [ ] Zanotowano liczbę wczytanych planów cenowych: `_______________________`
- [ ] Każdy pokój Booking przypisano do właściwego property albo room type.
- [ ] Każdy plan cenowy przypisano do właściwego apartamentu.
- [ ] Druga osoba sprawdziła mapowanie przed kontynuacją.
- [ ] Nie pozostawiono żadnego aktywnego planu bez mapowania.
- [ ] Nie zmapowano planu apartamentu 1 do apartamentu 2 ani odwrotnie.
- [ ] Zapisano zrzuty ekranu gotowego mapowania.

Oczekiwany stan po tym kroku: ceny/dostępność mogą pokazać `0`, a Booking może
oznaczyć ofertę jako zamkniętą lub nieprzyjmującą rezerwacji. To moment na
odtworzenie cen, a nie powód do przypadkowego rozłączania integracji.

## Etap D — odtworzenie cen i reguł w Hostex

- [ ] Otworzono `Price` / kalendarz cen Hostex.
- [ ] Wybrano podstawowy plan cenowy właściwego apartamentu.
- [ ] Ustawiono ceny dla **całego sprzedawanego okresu** zgodnie z matrycą.
- [ ] Ustawiono ceny sezonowe, weekendowe i wszystkie wyjątki.
- [ ] Ustawiono minimalną liczbę nocy i pozostałe ograniczenia dat.
- [ ] Sprawdzono zależne plany cenowe i ich relację do planu podstawowego.
- [ ] Powtórzono operację dla drugiego apartamentu, jeżeli został podłączony.
- [ ] Nie ma ceny `0`, ujemnej ani oczywiście błędnej na żadnym otwartym dniu.
- [ ] Nie ustawiono przypadkiem ceny w USD zamiast PLN.
- [ ] Nie otwarto dat zajętych istniejącą rezerwacją lub ręczną blokadą.
- [ ] Sprawdzono pierwszy i ostatni tydzień sprzedawanego okresu.
- [ ] Zapisano zrzuty cen po odtworzeniu.

Hostex podaje, że przy zależnych planach cenowych może wystarczyć ustawienie ceny
planu Standard, a pozostałe plany przeliczą się automatycznie. Nie zakładać tego
w ciemno — wynik każdego aktywnego planu trzeba sprawdzić.

## Etap E — kontrola rezerwacji i dostępności

Porównać Hostex z prywatnym eksportem Booking.com:

- [ ] Zgadza się liczba przyszłych rezerwacji albo każda różnica jest opisana.
- [ ] Zgadza się apartament każdej rezerwacji.
- [ ] Zgadza się data przyjazdu i wyjazdu.
- [ ] Zgadza się liczba gości, jeśli Hostex ją udostępnia.
- [ ] Wszystkie zajęte noce pozostają zamknięte.
- [ ] Ręczne blokady i pobyty właścicieli są widoczne.
- [ ] Rezerwacje sprzed połączenia są jednoznacznie oznaczone na prywatnej
  liście kontrolnej.
- [ ] Sprawdzono co najmniej: najbliższe 7 dni, następne 30 dni, święta,
  wakacje oraz ostatni miesiąc sprzedawanego okresu.
- [ ] Nie ma podwójnego przypisania tej samej rezerwacji.
- [ ] Nie ma wolnej daty w Hostex, która jest zajęta w Booking.com.

## Etap F — potwierdzenie w Booking.com i po stronie gościa

- [ ] Booking Extranet pokazuje Hostex jako aktywnego dostawcę connectivity.
- [ ] Ceny dotarły do Booking.com dla obu apartamentów i aktywnych planów.
- [ ] Waluta i kwoty są poprawne.
- [ ] Zajęte terminy są niedostępne.
- [ ] Wolne terminy są dostępne dopiero po prawidłowej publikacji cen.
- [ ] Minimalna liczba nocy i ograniczenia działają na przykładowych datach.
- [ ] Sprawdzono ofertę jak gość, w prywatnym oknie przeglądarki.
- [ ] Sprawdzono co najmniej jeden termin bliski i jeden odległy.
- [ ] Sprawdzono wariant dla poprawnej liczby gości.
- [ ] Końcowa cena dla gościa nie jest zerowa ani podejrzanie niska.
- [ ] Jeżeli Booking prowadzi weryfikację cen, zanotowano jej stan i nie uznano
  migracji za zakończoną przed ponownym otwarciem sprzedaży.

## Etap G — obserwacja po uruchomieniu

Wykonać kontrole:

- [ ] bezpośrednio po połączeniu,
- [ ] po 1 godzinie,
- [ ] następnego ranka,
- [ ] po 48 godzinach,
- [ ] po 72 godzinach,
- [ ] po 7 dniach.

Przy każdej kontroli sprawdzić:

- [ ] status połączenia Booking.com w Hostex,
- [ ] ceny kilku bliskich i odległych dat,
- [ ] dostępność obu apartamentów,
- [ ] nowe, zmienione i anulowane rezerwacje,
- [ ] wiadomości od gości,
- [ ] błędy lub ostrzeżenia synchronizacji,
- [ ] działanie odczytu `/api/hostex/properties`,
- [ ] działanie odczytu `/api/hostex/reservations`.

Pierwsza prawdziwa nowa rezerwacja po połączeniu:

- [ ] pojawiła się w Booking Extranecie,
- [ ] pojawiła się w Hostex,
- [ ] ma właściwy property i plan cenowy,
- [ ] ma właściwy status, termin i liczbę gości,
- [ ] jest widoczna przez nasze API,
- [ ] nie utworzyła duplikatu,
- [ ] została odróżniona od rezerwacji sprzed połączenia.

## Procedura dla rezerwacji sprzed połączenia

Do wyjazdu ostatniej starej rezerwacji, codziennie:

1. Otworzyć listę rezerwacji Booking.com zmienionych lub anulowanych.
2. Porównać je z prywatną listą kontrolną.
3. Każdą zmianę terminu, pokoju lub statusu ręcznie zweryfikować w Hostex.
4. W razie anulowania zaktualizować kalendarz Hostex albo skontaktować się ze
   wsparciem Hostex zgodnie z ich instrukcją.
5. Przed utworzeniem lub zmianą kodu TTLock sprawdzić aktualny status w
   Booking.com.
6. Zanotować wykonanie kontroli i osobę odpowiedzialną.

Po wyjeździe ostatniego gościa z rezerwacji sprzed połączenia można zakończyć tę
dodatkową procedurę, o ile nowe rezerwacje synchronizują się prawidłowo.

## Procedura awaryjna

Nie rozłączać Hostex impulsywnie. Rozłączenie zatrzymuje synchronizację, ale nie
jest automatycznym przywróceniem poprzedniej konfiguracji Booking.com.

Jeżeli ceny, mapowanie lub dostępność są nieprawidłowe:

1. Zatrzymać dalsze zmiany i zrobić zrzuty błędu.
2. Zamknąć sprzedaż błędnego zakresu w Hostex, jeżeli istnieje ryzyko
   overbookingu lub złej ceny.
3. Zapisać: apartament, plan cenowy, zakres dat, wartość oczekiwaną i faktyczną.
4. Nie usuwać property, listingów ani planów cenowych.
5. Skontaktować się z Hostex i Booking.com, podając Hotel ID i czas zdarzenia.
6. Po naprawie ponownie sprawdzić mapowanie, ceny, zajęte daty i widok gościa.
7. Dopiero po konsultacji decydować o ewentualnym rozłączeniu channel managera.

## Kryteria zakończenia migracji

Połączenie uznajemy za zakończone dopiero, gdy:

- [ ] wszystkie pokoje i plany cenowe są poprawnie zmapowane,
- [ ] cały sprzedawany okres ma prawidłowe ceny i ograniczenia,
- [ ] wszystkie istniejące rezerwacje i blokady zostały uzgodnione,
- [ ] Booking.com ponownie przyjmuje rezerwacje na poprawnych zasadach,
- [ ] widok gościa pokazuje prawidłowe ceny i dostępność,
- [ ] pierwsza nowa rezerwacja przeszła poprawnie do Hostex,
- [ ] nasze API odczytuje tę rezerwację bez błędu,
- [ ] właściciele wiedzą, że ceny, dostępność i ograniczenia zmieniają od tej
  chwili w Hostex, a nie bezpośrednio w kalendarzu Booking.com,
- [ ] działa codzienna kontrola rezerwacji sprzed połączenia.

## Oficjalne źródła Hostex

- [Booking.com Integration with Hostex: What to Know](https://hostex.io/help/booking-com-connection/)
- [Common Booking.com Integration Issues](https://hostex.io/help/booking-com-integration-instructions-faq-for-hostex/)
- [Why Your Booking.com Calendar Is Blocked](https://hostex.io/help/booking-com-calendar-blocked-after-connecting-to-hostex/)
- [How to Connect Channel Accounts](https://hostex.io/help/channel-accounts-connection/)
- [How to Link Listings](https://hostex.io/help/link-listings/)

Instrukcje dostawców mogą się zmieniać. W dniu połączenia trzeba ponownie
przeczytać aktualne komunikaty pokazane przez Hostex i Booking.com.
