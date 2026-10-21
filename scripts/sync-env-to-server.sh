#!/usr/bin/env bash
# Synchronizuje zmienne środowiskowe produkcji bez ręcznego przepisywania.
#
#   scripts/sync-env-to-server.sh            # podgląd i zapis po potwierdzeniu
#   scripts/sync-env-to-server.sh --dry-run  # tylko podgląd zmian
#
# Bazą jest obecny .env z serwera; brakujące sekrety są brane z lokalnego .env,
# a jawne flagi z deploy/production-flags.env. Wartości sekretów nie są
# wyświetlane. Przed zapisem na serwerze powstaje kopia .env.bak-<data>.
# Skrypt nie restartuje aplikacji — zmiany wejdą przy wdrożeniu/restarcie.
set -euo pipefail

SERVER="${DEPLOY_SERVER:-deploy@212.227.101.9}"
APP_DIR="${DEPLOY_APP_DIR:-/home/deploy/apps/api}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

for file in "$ROOT/.env" "$ROOT/.env.example" "$ROOT/deploy/production-flags.env"; do
  [[ -f "$file" ]] || { echo "Brak pliku: $file" >&2; exit 1; }
done

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

echo "Pobieram obecny .env z $SERVER..."
ssh "$SERVER" "cat '$APP_DIR/.env'" > "$WORK/server.env"

if ! grep -q '^HOSTEX_WEBHOOK_SECRET=..*' "$WORK/server.env"; then
  echo
  echo "Sekret webhooka Hostex (secret_token z panelu Hostex)."
  HOSTEX_WEBHOOK_SECRET_INPUT=""
  read -rsp "Wklej go i naciśnij Enter (samo Enter = pomiń na razie): " HOSTEX_WEBHOOK_SECRET_INPUT || true
  echo
  export HOSTEX_WEBHOOK_SECRET_INPUT
fi

node "$ROOT/scripts/merge-env.js" \
  --server "$WORK/server.env" \
  --local "$ROOT/.env" \
  --example "$ROOT/.env.example" \
  --flags "$ROOT/deploy/production-flags.env" \
  --out "$WORK/production.env"

if $DRY_RUN; then
  echo
  echo "Tryb podglądu — na serwerze nic nie zmieniono."
  exit 0
fi

echo
read -rp "Zapisać nowy .env na serwerze? [t/N] " answer
[[ "$answer" =~ ^[tTyY]$ ]] || { echo "Przerwano — nic nie zmieniono."; exit 0; }

STAMP="$(date +%Y%m%d-%H%M%S)"
ssh "$SERVER" "set -e; cd '$APP_DIR'; umask 077; cp -p .env .env.bak-$STAMP; cat > .env.new; chmod 600 .env.new; mv .env.new .env" \
  < "$WORK/production.env"

echo "Zapisano. Kopia poprzedniej wersji: $APP_DIR/.env.bak-$STAMP"
echo "Zmiany zadziałają po wdrożeniu lub restarcie aplikacji."
