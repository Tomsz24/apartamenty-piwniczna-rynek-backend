#!/usr/bin/env bash
# Wdraża gałąź main na serwer produkcyjny (PM2 `api`).
#
#   scripts/deploy.sh             # wdrożenie origin/main
#   scripts/deploy.sh --rollback  # powrót do wersji sprzed ostatniego wdrożenia
#
# Kroki: kopia (dist, .env, numer commita) → git ff do origin/main → npm ci →
# build → restart PM2 → sprawdzenie /api/health. Jeśli build, restart albo
# sprawdzenie się nie uda, skrypt sam przywraca poprzednią wersję.
# Migracje bazy uruchamiamy osobno, przed wdrożeniem (migrations/README.md).
set -euo pipefail

SERVER="${DEPLOY_SERVER:-deploy@212.227.101.9}"
APP_DIR="${DEPLOY_APP_DIR:-/home/deploy/apps/api}"
MODE="deploy"
[[ "${1:-}" == "--rollback" ]] && MODE="rollback"

if [[ "$MODE" == "deploy" ]]; then
  git fetch origin main --quiet
  echo "Wdrażam origin/main: $(git log -1 --format='%h %s' origin/main)"
  read -rp "Kontynuować? [t/N] " answer
  [[ "$answer" =~ ^[tTyY]$ ]] || { echo "Przerwano."; exit 0; }
else
  read -rp "Przywrócić wersję sprzed ostatniego wdrożenia? [t/N] " answer
  [[ "$answer" =~ ^[tTyY]$ ]] || { echo "Przerwano."; exit 0; }
fi

ssh "$SERVER" "bash -s -- '$APP_DIR' '$MODE'" <<'REMOTE'
# The whole script is one function so bash parses it before running anything:
# npm/pm2 reading stdin can then never swallow the rest of this script.
remote_main() {
set -euo pipefail
exec </dev/null
APP_DIR="$1"
MODE="$2"
export PATH="$HOME/n/bin:$PATH"
BACKUPS="$HOME/backups/api"
cd "$APP_DIR"

# strict: /api/health must return {"status":"ok"}; otherwise any non-5xx HTTP
# answer counts (older versions had no public health endpoint).
health_check() {
  local mode="${1:-strict}" code
  for attempt in $(seq 1 20); do
    if [[ "$mode" == "strict" ]]; then
      curl -fsS -m 3 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok"' && return 0
    else
      code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:3000/api/health || true)"
      [[ "$code" =~ ^[234] ]] && return 0
    fi
    sleep 2
  done
  return 1
}

restore() {
  local commit="$1" archive="$2"
  echo "↩️  Przywracam wersję $commit..."
  git reset --hard "$commit" --quiet
  npm ci --no-audit --no-fund --silent
  rm -rf dist
  tar -xzf "$archive" dist
  pm2 restart api --update-env >/dev/null
  if health_check any; then
    echo "Poprzednia wersja działa ($(git log -1 --format='%h %s'))."
  else
    echo "⚠️  Poprzednia wersja też nie odpowiada — sprawdź: pm2 logs api" >&2
  fi
}

if [[ "$MODE" == "rollback" ]]; then
  [[ -f .deploy-previous ]] || { echo "Brak zapisanej poprzedniej wersji." >&2; exit 1; }
  read -r commit archive < .deploy-previous
  restore "$commit" "$archive"
  exit 0
fi

mkdir -p "$BACKUPS"
STAMP="$(date +%Y%m%d-%H%M%S)"
PREVIOUS="$(git rev-parse HEAD)"
ARCHIVE="$BACKUPS/api-$STAMP-${PREVIOUS:0:7}.tgz"
tar -czf "$ARCHIVE" dist .env
echo "Kopia: $ARCHIVE"

# The server only ever runs main; npm install used to leave lockfile drift here.
git checkout -- package-lock.json 2>/dev/null || true
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Na serwerze są lokalne zmiany w plikach z repo — przerywam:" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

git fetch origin main --quiet
git merge --ff-only origin/main --quiet
echo "Kod: $(git log -1 --format='%h %s')"

if ! npm ci --no-audit --no-fund --silent || ! npm run build --silent; then
  echo "❌ Instalacja lub build nie powiodły się." >&2
  restore "$PREVIOUS" "$ARCHIVE"
  exit 1
fi

pm2 restart api --update-env >/dev/null
if ! health_check; then
  echo "❌ Nowa wersja nie odpowiada na /api/health. Ostatnie logi:" >&2
  pm2 logs api --nostream --lines 30 >&2 || true
  restore "$PREVIOUS" "$ARCHIVE"
  exit 1
fi

echo "$PREVIOUS $ARCHIVE" > .deploy-previous
pm2 save >/dev/null
# Keep the 10 newest backups.
ls -1t "$BACKUPS"/api-*.tgz 2>/dev/null | tail -n +11 | xargs -r rm -f
echo "✅ Wdrożono $(git log -1 --format='%h') — /api/health odpowiada."
}
remote_main "$@"
REMOTE
