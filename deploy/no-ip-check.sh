#!/usr/bin/env bash
# deploy/no-ip-check.sh - Try to make the relay or Caddy keep a client IP.
#
# Starts the relay with reconcile-relay.service's own Uvicorn flags on a temp
# database, and Caddy with deploy/Caddyfile (only its ports, upstream and app
# root moved to temp ones), and captures the stdout and stderr of both. Then,
# from 127.0.0.2 (curl --interface), it sends:
#   - a PUT and a GET carrying forwarding-header canaries;
#   - garbage where a TLS handshake belongs, and a handshake for a name with
#     no certificate;
#   - malformed HTTP, over TLS and on the plain HTTP port;
#   - 4xx requests with a canary in the path;
#   - a request that gets a 502, after stopping the relay.
# Each must get the response it expects, or the check isn't testing anything.
# Finally it greps the captured output, and the raw bytes of the SQLite file
# and its -wal and -shm, for 127.0.0.2 and the canaries. Any hit fails.
#
# Run it locally, from any directory, with .venv active (the relay's
# dependencies) and caddy and curl on PATH. macOS first needs:
#   sudo ifconfig lo0 alias 127.0.0.2
# Ports (all unprivileged): NO_IP_HTTP_PORT (default 18080),
# NO_IP_HTTPS_PORT (18443) and NO_IP_RELAY_PORT (18787).
#
# Usage: deploy/no-ip-check.sh [--help]

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$DEPLOY_DIR")"
CLIENT_IP=127.0.0.2
HTTP_PORT="${NO_IP_HTTP_PORT:-18080}"
HTTPS_PORT="${NO_IP_HTTPS_PORT:-18443}"
RELAY_PORT="${NO_IP_RELAY_PORT:-18787}"
PYTHON="${PYTHON:-python3}"

case "${1:-}" in
    "") ;;
    --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: Unknown option: $1" >&2; exit 2 ;;
esac

die() {
    echo "no-ip-check: $*" >&2
    exit 1
}

for tool in caddy curl "$PYTHON"; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool isn't on PATH."
done
"$PYTHON" -c 'import uvicorn, reconcile.relay.app' 2>/dev/null ||
    die "can't import the relay; activate .venv first."

work="$(mktemp -d)"
pids=()
cleanup() {
    local pid
    for pid in "${pids[@]+"${pids[@]}"}"; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    rm -rf "$work"
}
trap cleanup EXIT

# --- Canaries: values that must never be written anywhere -----------------
hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
canary="nipcanary$(hex 8)"
# RFC 5737 documentation range: an address that can't be anyone's.
canary_ip="203.0.113.$(( $(od -An -tu1 -N1 /dev/urandom) % 254 + 1 ))"
mailbox="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
CANARY_HEADERS=(
    -H "X-Forwarded-For: $canary_ip"
    -H "X-Real-IP: $canary_ip"
    -H "Forwarded: for=$canary_ip;host=$canary;proto=https"
    -H "X-Forwarded-Host: $canary"
    -H "X-Forwarded-Proto: $canary"
    -H "User-Agent: $canary"
    -H "Referer: https://$canary.invalid/"
)

# --- The relay, with the unit's flags -------------------------------------
read -r -a relay_args <<< "$(sed -n 's/^ExecStart=//p' "$DEPLOY_DIR/reconcile-relay.service")"
relay_args=("${relay_args[@]:1}")  # drop the venv's uvicorn: run python -m uvicorn
moved=false
for i in "${!relay_args[@]}"; do
    if [[ "${relay_args[$i]}" == --port ]]; then
        relay_args[i + 1]="$RELAY_PORT"
        moved=true
    fi
done
$moved || die "reconcile-relay.service's ExecStart has no --port to move."

mkdir -p "$work/state"
(cd "$PROJECT_ROOT" && exec env RECONCILE_RELAY_DB="$work/state/relay.db" \
    "$PYTHON" -m uvicorn "${relay_args[@]}" >"$work/relay.out" 2>"$work/relay.err") &
relay_pid=$!
pids+=("$relay_pid")

# --- Caddy, with the real Caddyfile moved to unprivileged ports -----------
mkdir -p "$work/app"
printf '<!doctype html><title>no-ip-check</title>\n' > "$work/app/index.html"
awk -v http="$HTTP_PORT" -v https="$HTTPS_PORT" \
    -v relay="127.0.0.1:$RELAY_PORT" -v app="$work/app" '
    { gsub(/127\.0\.0\.1:8787/, relay); gsub(/\/srv\/reconcile\/app/, app); print }
    /^[[:space:]]*admin off$/ { print "\thttp_port " http; print "\thttps_port " https }
' "$DEPLOY_DIR/Caddyfile" > "$work/Caddyfile"
for moved_line in "https_port $HTTPS_PORT" "reverse_proxy 127.0.0.1:$RELAY_PORT" "root * $work/app"; do
    grep -qF "$moved_line" "$work/Caddyfile" ||
        die "deploy/Caddyfile changed shape: update this script's substitutions."
done

RECONCILE_SITE=localhost XDG_DATA_HOME="$work/caddy-data" \
    XDG_CONFIG_HOME="$work/caddy-config" \
    caddy run --adapter caddyfile --config "$work/Caddyfile" \
    >"$work/caddy.out" 2>"$work/caddy.err" &
pids+=("$!")
ca="$work/caddy-data/caddy/pki/authorities/local/root.crt"

# --- Helpers ---------------------------------------------------------------
show_output() {
    local file
    for file in relay.out relay.err caddy.out caddy.err; do
        echo "--- $file" >&2
        cat "$work/$file" >&2 || true
    done
}

# Every request comes from CLIENT_IP and trusts only the temp Caddy CA.
from_client() {
    curl --interface "$CLIENT_IP" -sS --max-time 5 --cacert "$ca" \
        --resolve "localhost:$HTTPS_PORT:127.0.0.1" \
        --resolve "nocert.invalid:$HTTPS_PORT:127.0.0.1" "$@"
}

# expect STATUS LABEL CURL_ARGS...: the request must get exactly STATUS.
expect() {
    local want=$1 label=$2 got
    shift 2
    got="$(from_client -o "$work/body" -w '%{http_code}' "$@" 2>"$work/curl.err")" || true
    if [[ "$got" != "$want" ]]; then
        show_output
        die "$label got HTTP ${got:-000}, not $want: $(tr -d '\n' < "$work/curl.err")"
    fi
    printf '  %-52s %s\n' "$label" "$got"
}

# refused LABEL CURL_ARGS...: the request must fail before any HTTP response.
refused() {
    local label=$1 got
    shift
    got="$(from_client -o /dev/null -w '%{http_code}' "$@" 2>/dev/null)" && {
        show_output
        die "$label was answered (HTTP $got); it should have failed."
    }
    printf '  %-52s %s\n' "$label" "refused"
}

# raw LABEL PORT BYTES: send BYTES as they are. Whatever comes back is fine,
# but curl's exit code 7 means it never connected.
raw() {
    local status=0
    printf '%b' "$3" | curl --interface "$CLIENT_IP" -sS --max-time 2 \
        "telnet://127.0.0.1:$2" >/dev/null 2>&1 || status=$?
    [[ "$status" != 7 ]] || die "$1: couldn't connect to port $2."
    printf '  %-52s %s\n' "$1" "sent"
}

wait_until() {
    local what=$1
    shift
    for _ in $(seq 1 100); do
        if "$@" >/dev/null 2>&1; then
            return 0
        fi
        sleep 0.1
    done
    show_output
    die "$what didn't come up."
}

wait_until "the relay" curl -sf "http://127.0.0.1:$RELAY_PORT/v1/health"
wait_until "Caddy" from_client -f "https://localhost:$HTTPS_PORT/v1/health"

echo "no-ip-check: relay on 127.0.0.1:$RELAY_PORT, Caddy on :$HTTP_PORT and :$HTTPS_PORT, client $CLIENT_IP"
site="https://localhost:$HTTPS_PORT"

# --- 1. Normal traffic, with forwarding-header canaries --------------------
head -c 1024 /dev/urandom > "$work/blob"
expect 201 "PUT a blob (canary headers)" "${CANARY_HEADERS[@]}" -X PUT \
    -H 'Content-Type: application/octet-stream' --data-binary "@$work/blob" \
    "$site/v1/mailbox/$mailbox?ttl_days=1"
expect 200 "GET it back (canary headers)" "${CANARY_HEADERS[@]}" \
    "$site/v1/mailbox/$mailbox"
grep -qF "\"data\":\"$(base64 < "$work/blob" | tr -d '\n')\"" "$work/body" ||
    die "the GET didn't return the blob: the relay isn't behind Caddy."
expect 200 "GET the app (canary headers)" "${CANARY_HEADERS[@]}" "$site/"
expect 200 "GET an unknown app path: index.html" "${CANARY_HEADERS[@]}" "$site/$canary"
expect 308 "plain HTTP: redirected to HTTPS" "${CANARY_HEADERS[@]}" \
    "http://localhost:$HTTP_PORT/$canary"

# --- 2. Failed TLS handshakes ----------------------------------------------
raw "garbage instead of a TLS handshake" "$HTTPS_PORT" "\\x16\\x03\\x09$canary\\r\\n\\r\\n"
refused "TLS for a name with no certificate" "https://nocert.invalid:$HTTPS_PORT/"

# --- 3. Malformed HTTP -----------------------------------------------------
expect 400 "HTTP/1.1 with an invalid method" --http1.1 -X 'B@D' "${CANARY_HEADERS[@]}" "$site/v1/health"
expect 400 "HTTP/1.1 with an invalid Content-Length" --http1.1 \
    -H "Content-Length: $canary" "${CANARY_HEADERS[@]}" "$site/v1/health"
raw "a garbage request on the HTTP port" "$HTTP_PORT" "$canary /\\x01 HTTP/9.9\\r\\nHost: $canary\\r\\n\\r\\n"

# --- 4. Refusals from the relay --------------------------------------------
expect 400 "GET a malformed mailbox id (canary in path)" "${CANARY_HEADERS[@]}" \
    "$site/v1/mailbox/$canary"
expect 400 "PUT a blob of the wrong size" "${CANARY_HEADERS[@]}" -X PUT \
    -H 'Content-Type: application/octet-stream' --data-binary "$canary" \
    "$site/v1/mailbox/$mailbox"
expect 404 "GET an unknown API path (canary in path)" "${CANARY_HEADERS[@]}" "$site/v1/$canary"
expect 405 "DELETE a mailbox" "${CANARY_HEADERS[@]}" -X DELETE "$site/v1/mailbox/$mailbox"

# Snapshot the database while it runs: the -wal and -shm exist only then.
mkdir -p "$work/snapshot"
cp "$work/state/"relay.db* "$work/snapshot/"
for suffix in "" -wal -shm; do
    [[ -s "$work/snapshot/relay.db$suffix" ]] || die "no relay.db$suffix to check."
done
grep -qaF "$mailbox" "$work/snapshot/"relay.db* ||
    die "the mailbox id isn't in the SQLite files: they aren't the relay's."

# --- 5. A 502: Caddy's error log would name the client ---------------------
kill "$relay_pid"
wait "$relay_pid" 2>/dev/null || true
expect 502 "GET with the relay stopped (502)" "${CANARY_HEADERS[@]}" "$site/v1/health"

# --- The verdict -------------------------------------------------------------
grep -q 'Uvicorn running' "$work/relay.err" ||
    die "the relay's output wasn't captured."
files=("$work/relay.out" "$work/relay.err" "$work/caddy.out" "$work/caddy.err"
    "$work/snapshot/"relay.db* "$work/state/"relay.db*)
needles=(-e "$CLIENT_IP" -e "$canary" -e "$canary_ip")
if hits="$(grep -aFl "${needles[@]}" "${files[@]}")"; then
    echo "no-ip-check: FAIL: a client IP or canary was written:" >&2
    while IFS= read -r file; do
        echo "--- ${file#"$work/"}" >&2
        grep -aF "${needles[@]}" "$file" | head -c 2000 >&2
        echo >&2
    done <<< "$hits"
    exit 1
fi
echo "no-ip-check: PASS: no $CLIENT_IP or canary in Caddy's or Uvicorn's stdout or stderr, or in relay.db, -wal or -shm"
