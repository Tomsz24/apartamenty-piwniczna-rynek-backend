# Kontrakt backendu dla aplikacji iOS

API działa pod prefiksem `/api`. Daty rezerwacji to lokalne daty kalendarzowe
`YYYY-MM-DD`; dzień wyjazdu (`endDate`) nie jest zajętą nocą.

## Logowanie

Aplikacja loguje administratora przez Supabase Auth DEV. Do backendu wysyła
token sesji w nagłówku `Authorization: Bearer <access_token>`. Backend
weryfikuje token w Supabase Auth i dopuszcza tylko adresy z `ADMIN_EMAILS`.
Klucza `service_role` nie wolno umieszczać w aplikacji.

## Pierwsze wywołania

- `GET /api/health` — publiczny liveness check, nie sprawdza bazy.
- `GET /api/health/ready` — chroniony test połączenia z bazą.
- `GET /api/apartments` — chroniona lista apartamentów i godzin domyślnego
  dostępu do kodu TTLock.
- `GET /api/reservations?from=YYYY-MM-DD&to=YYYY-MM-DD` — chroniona lista;
  zakres zachowuje rezerwacje nachodzące na zadany przedział.
- `GET /api/calendars` — chronione kalendarze kompatybilnościowe.

## Rezerwacje

Pełny opis wraz z przykładami jest w [reservations-api.md](reservations-api.md).
Nowe rezerwacje tworzy `POST /api/reservations`, edytuje
`PATCH /api/reservations/:id`, a ręczne anuluje
`DELETE /api/reservations/:id`. Przy edycji przekazuj `expectedVersion`, by
wykryć równoległą zmianę. Rezerwacje importowane z Hostex pozostają
zarządzane synchronizacją źródła; aplikacja może edytować ich notatkę i dane
gościa, ale nie daty ani status.

`PATCH /api/reservations/:id` przyjmuje również opcjonalne pole
`arrivalMessageSentAt`. Przekazanie znacznika czasu oznacza ręczne
potwierdzenie wysłania wiadomości z kodem i mapką przez administratora;
przekazanie `null` cofa oznaczenie. `GET /api/reservations` zwraca ten status,
a `NULL` oznacza brak potwierdzenia. Wiadomość powitalna pozostaje obsługiwana
przez automatyzację Booking.com. Status nie wywołuje endpointu Hostex ani nie
wysyła wiadomości.

Typowa kolejność widoku kalendarza:

1. Pobierz `/api/apartments` i zachowaj ich UUID.
2. Pobierz rezerwacje dla widocznego zakresu i wybranego `apartmentId`.
3. Po mutacji użyj zwróconego obiektu, który zawiera zaktualizowaną `version`.
4. Przy `409 Conflict` odśwież rezerwację i pokaż administratorowi aktualny
   stan zamiast ponawiać zapis w ciemno.

## Pozostałe moduły

- Kody i ich powiązanie z rezerwacją: [access-codes-api.md](access-codes-api.md).
- Status, properties, rezerwacje i synchronizacja Hostex:
  [hostex-api.md](hostex-api.md).
- Lokalna konfiguracja profilu DEV: [local-development.md](local-development.md).

Wszystkie endpointy poza `GET /api/health` wymagają tokenu administratora.
W DEV należy używać osobnego Supabase projektu/brancha i syntetycznych
rezerwacji. Szczegóły przygotowania czystej bazy i konfiguracji środowiska są
opisane w dokumentacji DEV.
