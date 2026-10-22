# Wiadomość przyjazdowa

Wiadomość z kodem do drzwi i mapką dojazdu powstaje z szablonu apartamentu
(`apartment_message_templates`, typ `arrival`). Backend wstawia aktywny kod TTLock
w `{{apartment_access_code}}` oraz okres ważności w `{{access_code_valid_from}}` i
`{{access_code_valid_until}}` (np. `23.10.2026, godz. 12:00`, strefa apartamentu).
Mapka to publiczny plik z Supabase Storage wskazany w szablonie.

## Sposób doręczenia

| Rezerwacja | Doręczenie |
| --- | --- |
| Z kanału przez Hostex (Booking.com, Airbnb, …) z czatem | automatycznie w czacie Hostex o 10:00 |
| Ręczna albo utworzona w aplikacji (`hostex_direct`) | właściciel wysyła z telefonu przez iMessage |

## Automatyczna wysyłka (czat Hostex)

`ARRIVAL_MESSAGE_AUTO_SEND_ENABLED=true` włącza harmonogram o 10:00, 10:30, …,
13:30 (Europe/Warsaw). Każdy przebieg bierze potwierdzone pobyty z przyjazdem
dziś, z czatem kanału i bez oznaczonej wiadomości.

1. Pobyt jest najpierw zapisywany w `arrival_message_deliveries` (jeden wiersz na
   pobyt), dlatego restart ani drugi backend nie wyślą wiadomości drugi raz.
2. Bez aktywnego kodu nic nie jest wysyłane: status `failed`, krytyczny push
   „Nie wysłano wiadomości przyjazdowej”. Kolejne przebiegi ponawiają próbę, więc
   kod utworzony ręcznie przed 13:30 zostanie jeszcze wysłany.
3. Tekst idzie jako pierwsza wiadomość, mapka (`jpeg_base64`) jako druga. Po
   wysłaniu tekstu rezerwacja dostaje `arrival_message_sent_at`, a błąd mapki
   kończy się pushem „Wysłano wiadomość, ale bez mapki”.
4. Hostex nie zwraca ID wiadomości i wysyłka nie jest idempotentna. Odrzucenie
   przez Hostex oznacza brak wysyłki (`failed`, ponowienie). Timeout, zerwane
   połączenie albo 5xx oznacza nieznany wynik (`uncertain`): bez ponowienia,
   krytyczny push „Sprawdź czat z gościem”.

Treść wiadomości i kod nie są zapisywane w bazie ani w logach.

## Endpointy (administrator)

- `GET /api/reservations/:id/arrival-message` — gotowa treść, adres mapki, sposób
  doręczenia (`hostex_chat` / `imessage`), telefon gościa i stan wysyłki. Gdy kodu
  jeszcze nie ma, `text` jest `null`, a `missingReason` wyjaśnia dlaczego.
- `POST /api/reservations/:id/arrival-message/send` — „wyślij teraz” przez czat
  Hostex, np. przed 10:00. Dla rezerwacji bez czatu zwraca `400`.

Po wysłaniu przez iMessage aplikacja oznacza wiadomość przez
`PATCH /api/reservations/:id` z `arrivalMessageSentAt`.

## Przypomnienia

Dopóki wiadomość nie jest oznaczona jako wysłana, w dniu przyjazdu przychodzą
przypomnienia: 10:00 (`NOTIFICATION_ARRIVAL_REMINDER_TIME`), 13:00 (ważne) i
15:00 (krytyczne, „Gość może już być na miejscu”). Wysyłane jest tylko ostatnie
osiągnięte przypomnienie, więc restart nie wyśle kilku naraz. Pobyty z kanałów
dostają wiadomość automatycznie o 10:00, więc przypomnienia zaczynają się dla nich
o 13:00 — tylko gdy wysyłka się nie udała.
