#!/usr/bin/env bash
# deploy/smoke.sh - Prove a running relay stores and returns a blob.
#
# Against BASE_URL (deploy/deploy.sh passes https://$RECONCILE_SITE):
#   1. GET /v1/health answers {"status":"ok"}.
#   2. PUT a random 1,024-byte blob, ttl_days=1, to a random 43-character
#      mailbox: 201 and a seq.
#   3. GET that mailbox after seq-1: the same bytes come back.
#   4. GET /v1/push/key answers the VAPID public key: 87 base64url
#      characters, so push is on (#89).
# The blob expires within two days and nobody else knows the mailbox id.
# On failure it names the step and the HTTP status (000: no response), and
# exits 1.
#
# curl verifies TLS as usual; CURL_CA_BUNDLE points it at a local CA.
#
# Usage: deploy/smoke.sh BASE_URL

set -euo pipefail

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
    --help) usage; exit 0 ;;
    "") usage >&2; exit 2 ;;
    -*) echo "Error: Unknown option: $1" >&2; exit 2 ;;
esac
if [[ $# -ne 1 ]]; then
    usage >&2
    exit 2
fi
base="${1%/}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

started=false

fail() {
    if $started; then
        echo
    fi
    echo "smoke: FAIL at $1: HTTP $2${3:+ ($3)}" >&2
    exit 1
}

# request STEP METHOD PATH [curl args...]: the body lands in $work/body and
# the status in $status.
request() {
    local step=$1 method=$2 path=$3
    shift 3
    status="$(curl -sS --max-time 15 -o "$work/body" -w '%{http_code}' \
        -X "$method" "$@" "$base$path" 2>"$work/curl.err")" || {
        fail "$step" "${status:-000}" "$(tr -d '\n' < "$work/curl.err")"
    }
}

body() { cat "$work/body"; }

# 43 base64url characters: 32 random bytes, unpadded, as the client makes them.
mailbox="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
head -c 1024 /dev/urandom > "$work/blob"
expected="$(base64 < "$work/blob" | tr -d '\n')"

request health GET /v1/health
[[ "$status" == 200 && "$(body)" == '{"status":"ok"}' ]] ||
    fail health "$status" "$(body)"
printf 'smoke: health ok'
started=true

request put PUT "/v1/mailbox/$mailbox?ttl_days=1" \
    -H 'Content-Type: application/octet-stream' --data-binary "@$work/blob"
seq="$(sed -n 's/^{"seq":\([0-9][0-9]*\)}$/\1/p' "$work/body")"
[[ "$status" == 201 && -n "$seq" ]] || fail put "$status" "$(body)"
printf ' · put seq %s' "$seq"

request get GET "/v1/mailbox/$mailbox?after=$((seq - 1))&limit=1"
[[ "$status" == 200 ]] || fail get "$status" "$(body)"
[[ "$(body)" == *"{\"seq\":$seq,"*"\"data\":\"$expected\"}"* ]] ||
    fail get "$status" "the blob that came back differs from the one sent"
printf ' · get matches'

request push GET /v1/push/key
[[ "$status" == 200 && "$(body)" =~ ^\{\"vapid_public_key\":\"[A-Za-z0-9_-]{87}\"\}$ ]] ||
    fail push "$status" "$(body)"
echo ' · push key · PASS'
