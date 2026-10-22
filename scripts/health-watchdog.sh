#!/usr/bin/env bash
# Strażnik API uruchamiany na serwerze z crona co 5 minut (scripts/install-watchdog.sh).
#
#   scripts/health-watchdog.sh          # jedno sprawdzenie
#   scripts/health-watchdog.sh --test   # wysyła mail testowy
#
# Sprawdza /api/health lokalnie (proces PM2) i przez domenę (Nginx + SSL).
# Po dwóch nieudanych sprawdzeniach z rzędu wysyła jeden mail o awarii, a po
# powrocie — jeden mail, że działa. Dwa sprawdzenia, żeby restart przy
# wdrożeniu nie dawał fałszywych alarmów. Mail idzie przez Resend wyłącznie na
# ALERT_EMAIL_TO z .env (bez RESERVATION_EMAIL_TO).
# Nie wykryje wyłączenia całego serwera — to wymaga monitoringu z zewnątrz.
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCAL_URL="${WATCHDOG_LOCAL_URL:-http://127.0.0.1:3000/api/health}"
PUBLIC_URL="${WATCHDOG_PUBLIC_URL:-https://api.api.apartamenty-piwniczna-rynek.pl/api/health}"
STATE_FILE="${WATCHDOG_STATE_FILE:-$HOME/.api-watchdog-state}"
FAILURES_BEFORE_ALERT=2
export PATH="$HOME/n/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

env_value() {
  grep -E "^$1=" "$APP_DIR/.env" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'
}

check() {
  curl -fsS -m 10 "$1" 2>/dev/null | grep -q '"ok"'
}

send_email() {
  local subject="$1" body="$2"
  local key from to
  key="$(env_value RESEND_API_KEY)"
  from="$(env_value RESERVATION_EMAIL_FROM)"
  to="$(env_value ALERT_EMAIL_TO)"
  if [[ -z "$key" || -z "$from" || -z "$to" ]]; then
    echo "$(date -Is) Brak RESEND_API_KEY, RESERVATION_EMAIL_FROM albo ALERT_EMAIL_TO — mail nie wysłany: $subject" >&2
    return 1
  fi
  local payload
  payload="$(SUBJECT="$subject" BODY="$body" FROM="$from" TO="$to" python3 -c '
import json, os
print(json.dumps({
    "from": "Apartamenty Piwniczna — monitoring <%s>" % os.environ["FROM"],
    "to": [os.environ["TO"]],
    "subject": os.environ["SUBJECT"],
    "text": os.environ["BODY"],
}))')"
  if ! curl -fsS -m 20 -o /dev/null https://api.resend.com/emails \
      -H "Authorization: Bearer $key" -H 'Content-Type: application/json' -d "$payload"; then
    echo "$(date -Is) Resend nie przyjął maila: $subject" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--test" ]]; then
  send_email "Test: monitoring API działa" \
    "To jest mail testowy ze strażnika API na serwerze $(hostname). Jeśli go widzisz, alerty o awarii dotrą na ten adres." \
    && echo "Wysłano mail testowy."
  exit $?
fi

failures=0
alerted=0
since=""
[[ -f "$STATE_FILE" ]] && read -r failures alerted since < "$STATE_FILE"
failures="${failures:-0}"; alerted="${alerted:-0}"

problem=""
if ! check "$LOCAL_URL"; then
  problem="Aplikacja nie odpowiada lokalnie ($LOCAL_URL)."
elif ! check "$PUBLIC_URL"; then
  problem="Aplikacja działa, ale nie odpowiada przez domenę ($PUBLIC_URL) — sprawdź Nginx i certyfikat SSL."
fi

if [[ -z "$problem" ]]; then
  if [[ "$alerted" == "1" ]]; then
    send_email "API znów działa" \
      "API odpowiada poprawnie od $(date '+%Y-%m-%d %H:%M'). Awaria trwała od ${since/_/ }."
  fi
  echo "0 0 -" > "$STATE_FILE"
  exit 0
fi

failures=$((failures + 1))
[[ "$failures" == "1" ]] && since="$(date '+%Y-%m-%d_%H:%M')"
if (( failures >= FAILURES_BEFORE_ALERT )) && [[ "$alerted" != "1" ]]; then
  pm2_status="$(pm2 jlist 2>/dev/null | python3 -c '
import json, sys
try:
    apps = json.load(sys.stdin)
    print("\n".join("%s: %s, restarty: %s" % (a["name"], a["pm2_env"]["status"], a["pm2_env"].get("restart_time")) for a in apps) or "brak procesów")
except Exception:
    print("nie udało się odczytać PM2")
' 2>/dev/null)"
  if send_email "AWARIA: API apartamentów nie odpowiada" \
"$problem

Pierwsze nieudane sprawdzenie: ${since/_/ }.
Stan PM2:
${pm2_status:-nieznany}

Co sprawdzić:
  ssh ${WATCHDOG_SSH:-deploy@212.227.101.9}
  pm2 logs api --lines 50
Wycofanie ostatniego wdrożenia: scripts/deploy.sh --rollback (z komputera)."; then
    alerted=1
  fi
fi
echo "$failures $alerted $since" > "$STATE_FILE"
