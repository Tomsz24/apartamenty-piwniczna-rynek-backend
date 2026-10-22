#!/usr/bin/env bash
# Włącza na serwerze strażnika API (scripts/health-watchdog.sh) w cronie co 5 minut
# i ustawia adres alertów ALERT_EMAIL_TO z deploy/production-flags.env.
#
#   scripts/install-watchdog.sh          # instalacja + mail testowy
#   scripts/install-watchdog.sh --remove # wyłączenie strażnika
#
# Najpierw wdróż kod (scripts/deploy.sh), bo cron uruchamia skrypt z katalogu
# aplikacji na serwerze. Ponowne uruchomienie niczego nie dubluje.
set -euo pipefail

SERVER="${DEPLOY_SERVER:-deploy@212.227.101.9}"
APP_DIR="${DEPLOY_APP_DIR:-/home/deploy/apps/api}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="install"
[[ "${1:-}" == "--remove" ]] && MODE="remove"

ALERT_EMAIL_TO="$(grep -E '^ALERT_EMAIL_TO=' "$ROOT/deploy/production-flags.env" | cut -d= -f2-)"
if [[ "$MODE" == "install" && ! "$ALERT_EMAIL_TO" =~ ^[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+$ ]]; then
  echo "Ustaw jeden adres ALERT_EMAIL_TO w deploy/production-flags.env." >&2
  exit 1
fi

ssh "$SERVER" "bash -s -- '$APP_DIR' '$MODE' '$ALERT_EMAIL_TO'" <<'REMOTE'
remote_main() {
set -euo pipefail
exec </dev/null
APP_DIR="$1"
MODE="$2"
ALERT_EMAIL_TO="$3"
SCRIPT="$APP_DIR/scripts/health-watchdog.sh"
MARKER="# api-health-watchdog"

current_cron="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"
if [[ "$MODE" == "remove" ]]; then
  printf '%s\n' "$current_cron" | sed '/^$/d' | crontab -
  echo "Strażnik wyłączony."
  exit 0
fi

[[ -f "$SCRIPT" ]] || { echo "Brak $SCRIPT — najpierw wdróż kod (scripts/deploy.sh)." >&2; exit 1; }
chmod +x "$SCRIPT"

cd "$APP_DIR"
if [[ "$(grep -E '^ALERT_EMAIL_TO=' .env | cut -d= -f2- || true)" != "$ALERT_EMAIL_TO" ]]; then
  cp .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
  grep -v -E '^ALERT_EMAIL_TO=' .env > .env.tmp || true
  echo "ALERT_EMAIL_TO=$ALERT_EMAIL_TO" >> .env.tmp
  chmod --reference=.env .env.tmp 2>/dev/null || chmod 600 .env.tmp
  mv .env.tmp .env
  echo "Ustawiono ALERT_EMAIL_TO w .env."
fi

{ printf '%s\n' "$current_cron" | sed '/^$/d'
  echo "*/5 * * * * $SCRIPT >> \$HOME/api-watchdog.log 2>&1 $MARKER"
} | crontab -
echo "Cron: sprawdzenie co 5 minut."

"$SCRIPT" --test
}
remote_main "$@"
REMOTE
