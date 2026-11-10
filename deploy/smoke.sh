#!/usr/bin/env bash
# deploy/smoke.sh - Prove a running relay stores and returns a blob.
#
# Against BASE_URL (deploy/deploy.sh passes https://$RECONCILE_SITE):
#   1. GET /v1/health answers {"status":"ok"}.
#   2. PUT a random 1,024-byte blob, ttl_days=1, to a random 43-character
#      mailbox: 201 and a seq.
#   3. GET that mailbox after seq-1: the same bytes come back.
#   4. PUT a random 65,536-byte backup to a random 43-character id: 204.
#      GET it: the same bytes come back as application/octet-stream (#97).
#   5. GET /v1/push/key answers the VAPID public key: 87 base64url
#      characters, so push is on (#89).
# The blob expires within two days and the backup within 181, and nobody
# else knows either id.
# On failure it names the step and the HTTP status (000: no response), and
# exits 1.
#
# curl verifies TLS as usual; CURL_CA_BUNDLE points it at a local CA.
#
# Usage: deploy/smoke.sh BASE_URL

set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

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

# request STEP METHOD PATH [curl args...]: the body lands in $work/body, the
# status in $status and the Content-Type in $kind.
request() {
    local step=$1 method=$2 path=$3 out
    shift 3
    out="$(curl -sS --max-time 15 -o "$work/body" -w '%{http_code} %{content_type}' \
        -X "$method" "$@" "$base$path" 2>"$work/curl.err")" || {
        out="${out%% *}"
        fail "$step" "${out:-000}" "$(tr -d '\n' < "$work/curl.err")"
    }
    status="${out%% *}"
    kind="${out#* }"
}

body() { cat "$work/body"; }

# 43 base64url characters: 32 random bytes, unpadded, as the client makes them.
random_id() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
mailbox="$(random_id)"
backup="$(random_id)"
head -c 1024 /dev/urandom > "$work/blob"
head -c 65536 /dev/urandom > "$work/backup"
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

request backup-put PUT "/v1/backup/$backup" \
    -H 'Content-Type: application/octet-stream' --data-binary "@$work/backup"
[[ "$status" == 204 ]] || fail backup-put "$status" "$(body)"

request backup-get GET "/v1/backup/$backup"
[[ "$status" == 200 && "$kind" == application/octet-stream ]] ||
    fail backup-get "$status" "$kind"
cmp -s "$work/body" "$work/backup" ||
    fail backup-get "$status" "the backup that came back differs from the one sent"
printf ' · backup matches'

request push GET /v1/push/key
[[ "$status" == 200 && "$(body)" =~ ^\{\"vapid_public_key\":\"[A-Za-z0-9_-]{87}\"\}$ ]] ||
    fail push "$status" "$(body)"
echo ' · push key · PASS'
