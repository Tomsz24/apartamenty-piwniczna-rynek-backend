# Lokalna praca nad backendem

Projekt używa jednego backendu i jednego `.env`. Nie ma osobnego profilu DEV
ani pliku `.env.development.example`.

1. Zainstaluj zależności: `npm ci`.
2. Przy pierwszej konfiguracji skopiuj `.env.example` do `.env` i uzupełnij
   dane. Nie nadpisuj istniejącego `.env` zawierającego sekrety.
3. Uruchom `npm run start:dev` dla automatycznego restartu przy zmianie kodu.

To połączenie z właściwą bazą i usługami. Testy jednostkowe (`npm test`) używają
mocków; opcjonalny test migracji e-mail używa osobnego silnika PGlite.
Testy przez API backendu mogą zmieniać rzeczywiste rezerwacje i zamki zgodnie
z włączonymi integracjami.

Konfiguracja: [environment.md](environment.md).
