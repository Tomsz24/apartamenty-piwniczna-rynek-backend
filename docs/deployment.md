# Wdrożenie na serwer

Serwer: `ssh deploy@212.227.101.9`, aplikacja w `~/apps/api` (klon repo, gałąź
`main`), proces PM2 `api`, Nginx kieruje
`https://api.api.apartamenty-piwniczna-rynek.pl` na port 3000. Node jest
zainstalowany przez `n` (`~/n/bin`).

## Kolejność

1. Zmiany scalone do `main` przez PR.
2. Migracje bazy uruchomione w Supabase (SQL Editor), jeśli wersja ich wymaga
   — zob. `migrations/README.md`.
3. Zmienne środowiskowe: `scripts/sync-env-to-server.sh`.
4. Wdrożenie: `scripts/deploy.sh`.

## Zmienne środowiskowe

```bash
scripts/sync-env-to-server.sh --dry-run   # tylko podgląd
scripts/sync-env-to-server.sh             # zapis po potwierdzeniu
```

- Bazą jest obecny `.env` z serwera (np. `DATABASE_URL` zostaje bez zmian).
- Brakujące sekrety są kopiowane z lokalnego `.env`.
- Jawne flagi i identyfikatory produkcji są w `deploy/production-flags.env`
  i zawsze wygrywają. Włączenie funkcji = zmiana flagi w tym pliku, ponowne
  uruchomienie skryptu i wdrożenie.
- Skrypt pyta o `HOSTEX_WEBHOOK_SECRET`, jeśli na serwerze go nie ma.
- Jeśli na serwerze nie ma `ACCESS_CODE_ENCRYPTION_KEY`, generuje nowy. Skopiuj
  go do menedżera haseł:
  `ssh deploy@212.227.101.9 'grep ^ACCESS_CODE_ENCRYPTION_KEY= ~/apps/api/.env'`.
  Nie zmieniaj tego klucza, gdy w bazie są zaszyfrowane kody.
- Wartości sekretów nie są wyświetlane. Przed zapisem powstaje kopia
  `~/apps/api/.env.bak-<data>`.

Klucz APNs leży poza repozytorium: `/home/deploy/secrets/apns.p8` (`chmod 600`).

## Wdrożenie i powrót

```bash
scripts/deploy.sh              # wdrożenie origin/main
scripts/deploy.sh --rollback   # powrót do wersji sprzed ostatniego wdrożenia
```

Skrypt:

1. zapisuje kopię `dist` i `.env` w `~/backups/api/` (10 ostatnich),
2. przesuwa kod do `origin/main` (tylko fast-forward),
3. wykonuje `npm ci` i `npm run build`,
4. restartuje PM2 i czeka, aż `GET /api/health` zwróci `{"status":"ok"}`.

Jeśli build, restart albo sprawdzenie się nie uda, skrypt sam przywraca
poprzedni commit i poprzedni `dist`. Logi: `ssh deploy@212.227.101.9`, potem
`pm2 logs api`.

## Jeden backend na bazę

Lokalny backend korzysta z tej samej bazy co produkcja. Po wdrożeniu ustaw w
lokalnym `.env`: `HOSTEX_SYNC_ENABLED=false`, `ACCESS_CODE_AUTOMATION_ENABLED=false`,
`RESERVATION_EMAIL_ENABLED=false`, `NOTIFICATIONS_ENABLED=false`, aby
synchronizacja, kody, e-maile i pushe działały tylko na serwerze.
