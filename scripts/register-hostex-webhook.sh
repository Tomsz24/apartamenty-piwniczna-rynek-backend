#!/usr/bin/env bash
# Tworzy webhook Hostex przez Open API bezpośrednio z serwera i zapisuje
# zwrócony secret_token w ~/apps/api/.env (HOSTEX_WEBHOOK_SECRET).
# Sekret nie jest wyświetlany ani nie opuszcza serwera. Używa tokenu
# HOSTEX_ACCESS_TOKEN z .env na serwerze (najlepiej z uprawnieniem Write).
# Po zapisie zrestartuj aplikację: pm2 restart api --update-env.
set -euo pipefail

SERVER="${DEPLOY_SERVER:-deploy@212.227.101.9}"
APP_DIR="${DEPLOY_APP_DIR:-/home/deploy/apps/api}"
WEBHOOK_URL="${HOSTEX_WEBHOOK_URL:-https://api.api.apartamenty-piwniczna-rynek.pl/api/hostex/webhook}"

ssh "$SERVER" "bash -s -- '$APP_DIR' '$WEBHOOK_URL'" <<'REMOTE'
remote_main() {
set -euo pipefail
exec </dev/null
cd "$1"
export WEBHOOK_URL="$2"
export HOSTEX_TOKEN="$(grep '^HOSTEX_ACCESS_TOKEN=' .env | cut -d= -f2-)"
[[ -n "$HOSTEX_TOKEN" ]] || { echo "Brak HOSTEX_ACCESS_TOKEN w .env" >&2; exit 1; }

RESULT="$(python3 - <<'PY'
import json, os, urllib.request
body = json.dumps({
    "url": os.environ["WEBHOOK_URL"],
    "events": ["reservation_created", "reservation_updated", "message_created"],
}).encode()
request = urllib.request.Request(
    "https://api.hostex.io/v3/webhooks", data=body, method="POST",
    # Cloudflare in front of Hostex rejects the default Python-urllib agent (error 1010).
    headers={
        "Hostex-Access-Token": os.environ["HOSTEX_TOKEN"],
        "Content-Type": "application/json",
        "User-Agent": os.environ.get("HOSTEX_USER_AGENT") or "ApartamentyPiwnicznaBackend/1.0",
    },
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.load(response)
except urllib.error.HTTPError as error:
    payload = {"error_code": error.code, "error_msg": error.read().decode()[:200]}
data = payload.get("data") or {}
secret = data.get("secret_token") or ""
if secret:
    print(f"OK {data.get('id')} {secret}")
else:
    print(f"ERR {payload.get('error_code')} {payload.get('error_msg')}")
PY
)"

if [[ "$RESULT" == OK* ]]; then
  read -r _ id secret <<<"$RESULT"
  umask 077
  sed -i "s|^HOSTEX_WEBHOOK_SECRET=.*|HOSTEX_WEBHOOK_SECRET=$secret|" .env
  grep -q '^HOSTEX_WEBHOOK_SECRET=' .env || echo "HOSTEX_WEBHOOK_SECRET=$secret" >> .env
  echo "✅ Utworzono webhook Hostex (id $id); sekret zapisany w .env."
else
  echo "❌ Hostex odrzucił utworzenie webhooka: ${RESULT#ERR }" >&2
  exit 1
fi
}
remote_main "$@"
REMOTE
