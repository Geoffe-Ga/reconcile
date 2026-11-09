#!/usr/bin/env bash
# deploy/check.sh - Validate the deploy config without a VM (CI's deploy job).
#
#   1. caddy validate: the Caddyfile adapts and provisions, with
#      RECONCILE_SITE=localhost:8443.
#   2. The adapted config keeps the privacy settings: the admin API is off,
#      and the only logger is the default one, writing to discard.
#   3. The adapted config's site routes and its error routes (handle_errors,
#      for the responses Caddy writes itself, such as a 502) each set one
#      Strict-Transport-Security header, to exactly max-age=31536000
#      (deploy/README.md says why).
#   4. Both also set the Caddyfile's CSP and delete the Server header, and
#      the error routes hold no placeholder, so an error response can't echo
#      the request or the relay's error. deploy/no-ip-check.sh proves it on a
#      real 502.
#   5. systemd-analyze verify --recursive-errors=no: the three units, in a
#      temp root holding only them and a stub at each ExecStart binary
#      (verify refuses a missing one). Only these units are judged, so the
#      host's own units (a CI runner's dracut units, say) can't fail it. A
#      misspelled key or an unparsable value fails, though systemd would
#      merely ignore it, and so does any other output. A control copy with
#      a misspelled key must fail, or the check isn't testing anything.
#   6. client/vite.config.ts serves the Caddyfile's CSP under vite preview.
#
# Needs caddy and systemd-analyze on PATH (Linux; see deploy/README.md).
# ./scripts/check-all.sh runs this whenever deploy/ changes.
#
# Usage: deploy/check.sh [--verbose] [--help]

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$DEPLOY_DIR")"
UNITS=(reconcile-relay.service reconcile-purge.service reconcile-purge.timer)
# What the README's one-time setup and requirements.txt put in the venv.
EXECUTABLES=(/opt/reconcile/venv/bin/uvicorn /opt/reconcile/venv/bin/python)
TEST_SITE=localhost:8443
# A year, with no includeSubDomains and no preload: deploy/README.md says why.
HSTS='max-age=31536000'
# In the adapted JSON, the site's routes come first, then its error routes
# (handle_errors) under this key.
ERRORS_KEY='"errors":{"routes":'

VERBOSE=false
for arg in "$@"; do
    case "$arg" in
        --verbose) VERBOSE=true ;;
        --help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Error: Unknown option: $arg" >&2; exit 2 ;;
    esac
done

for tool in caddy systemd-analyze; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "deploy/check.sh needs $tool on PATH (see deploy/README.md)." >&2
        exit 2
    fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0

# Each check below returns non-zero itself: bash clears `set -e` inside the
# command substitution that runs it.

# Caddy with its storage (the local CA validate provisions) in the temp dir.
caddy_here() {
    RECONCILE_SITE="$TEST_SITE" XDG_DATA_HOME="$work/data" \
        XDG_CONFIG_HOME="$work/config" caddy "$@"
}

validate_caddyfile() {
    caddy_here validate --adapter caddyfile --config "$DEPLOY_DIR/Caddyfile"
}

adapt_caddyfile() {
    caddy_here adapt --adapter caddyfile --config "$DEPLOY_DIR/Caddyfile"
}

# Fail unless the adapted JSON contains $2; $3 says what it means.
expect_json() {
    if [[ "$1" != *"$2"* ]]; then
        echo "The adapted Caddyfile must contain $2 ($3)."
        return 1
    fi
}

check_privacy_settings() {
    local json status=0
    json="$(adapt_caddyfile)" || return 1
    expect_json "$json" '"admin":{"disabled":true}' "admin off" || status=1
    # Exactly this: a site `log`, a second logger or a level would change it.
    expect_json "$json" '"logging":{"logs":{"default":{"writer":{"output":"discard"}}}}' \
        "one logger, the default, writing to discard" || status=1
    return "$status"
}

# caddyfile_csp: the value of the Caddyfile's one Content-Security-Policy line.
caddyfile_csp() {
    local csp
    csp="$(sed -n 's/^[[:space:]]*Content-Security-Policy "\(.*\)"$/\1/p' "$DEPLOY_DIR/Caddyfile")"
    if [[ -z "$csp" || "$csp" == *$'\n'* ]]; then
        echo "deploy/Caddyfile must set one Content-Security-Policy header." >&2
        return 1
    fi
    printf '%s\n' "$csp"
}

# split_routes JSON: set $site and $errors to the adapted JSON's site routes
# and its error routes, or fail if there are none. Caddy writes some
# responses itself (a 502 while the relay is down, say), and those skip the
# site's routes, header block included (#159).
split_routes() {
    if [[ "$1" != *"$ERRORS_KEY"* ]]; then
        echo "The adapted Caddyfile must have error routes (handle_errors) for the responses Caddy writes itself."
        return 1
    fi
    site="${1%%"$ERRORS_KEY"*}"
    errors="${1#*"$ERRORS_KEY"}"
}

# set_once PART WHERE NAME VALUE: PART sets header NAME to exactly VALUE, and
# names NAME only once, in any letter case.
set_once() {
    local rest
    expect_json "$1" "\"$3\":[\"$4\"]" "$3 in $2" || return 1
    rest="${1,,}"
    rest="${rest#*"${3,,}"}"
    if [[ "$rest" == *"${3,,}"* ]]; then
        echo "The adapted Caddyfile must name $3 only once in $2."
        return 1
    fi
}

# The site's routes and its error routes each set HSTS once. Removing the
# header from either, changing its value or setting it a second time (in a
# handle block, say, in any letter case) fails.
check_hsts() {
    local json site errors status=0
    json="$(adapt_caddyfile)" || return 1
    split_routes "$json" || return 1
    set_once "$site" "the site's routes" Strict-Transport-Security "$HSTS" || status=1
    set_once "$errors" "the error routes" Strict-Transport-Security "$HSTS" || status=1
    return "$status"
}

# The site's routes and its error routes each set the Caddyfile's CSP once
# and delete the Server header, and the error routes fill in nothing from
# the request or the error.
check_security_headers() {
    local json csp site errors status=0
    json="$(adapt_caddyfile)" || return 1
    csp="$(caddyfile_csp)" || return 1
    split_routes "$json" || return 1
    set_once "$site" "the site's routes" Content-Security-Policy "$csp" || status=1
    set_once "$errors" "the error routes" Content-Security-Policy "$csp" || status=1
    expect_json "$site" '"delete":["Server"]' "no Server header from the site's routes" || status=1
    expect_json "$errors" '"delete":["Server"]' "no Server header from the error routes" || status=1
    # Compact JSON opens an object with { then " or }, so { then a letter
    # starts a placeholder, such as {err.message} or {http.request.uri}.
    if [[ "$errors" =~ \{[[:alpha:]][^}]*\} ]]; then
        echo "The error routes must hold no placeholder, not ${BASH_REMATCH[0]}: an error response must not echo the request or the relay's error."
        status=1
    fi
    return "$status"
}

# make_root ROOT: a tree holding only our units, and a stub at each ExecStart
# binary.
make_root() {
    local root=$1 exe unit
    mkdir -p "$root/etc/systemd/system" || return 1
    for exe in "${EXECUTABLES[@]}"; do
        mkdir -p "$root$(dirname "$exe")" || return 1
        printf '#!/bin/sh\nexit 0\n' > "$root$exe" || return 1
        chmod 755 "$root$exe" || return 1
    done
    for unit in "${UNITS[@]}"; do
        cp "$DEPLOY_DIR/$unit" "$root/etc/systemd/system/$unit" || return 1
    done
}

# verify_in ROOT: verify our units in ROOT, failing on any output.
verify_in() {
    local root=$1 unit out
    local paths=()
    for unit in "${UNITS[@]}"; do
        paths+=("$root/etc/systemd/system/$unit")
    done
    out="$(systemd-analyze verify --recursive-errors=no --root="$root" \
        "${paths[@]}" 2>&1)" || {
        printf '%s\n' "$out"
        return 1
    }
    if [[ -n "$out" ]]; then
        printf '%s\n' "$out"
        return 1
    fi
}

verify_units() {
    make_root "$work/root" || return 1
    verify_in "$work/root" || return 1
    make_root "$work/control" || return 1
    printf '[Service]\nRestat=on-failure\n' >> "$work/control/etc/systemd/system/${UNITS[0]}" ||
        return 1
    if verify_in "$work/control" >/dev/null; then
        echo "systemd-analyze verify accepted a misspelled key, so it can't vouch for the units."
        return 1
    fi
}

check_preview_csp() {
    local csp
    csp="$(caddyfile_csp)" || return 1
    if ! grep -qF "\"$csp\"" "$PROJECT_ROOT/client/vite.config.ts"; then
        echo "client/vite.config.ts must serve the Caddyfile's CSP under preview.headers:"
        echo "  $csp"
        return 1
    fi
}

# report NAME: the verdict on the check that just ran, from $status and $out.
# Its output shows when it failed, or with --verbose.
report() {
    if [[ "$status" == 0 ]]; then
        echo "✓ $1"
        if $VERBOSE && [[ -n "$out" ]]; then
            printf '%s\n' "$out"
        fi
    else
        echo "✗ $1"
        printf '%s\n' "$out"
        failed=1
    fi
}

status=0
out="$(validate_caddyfile 2>&1)" || status=$?
report "caddy validate (deploy/Caddyfile)"

status=0
out="$(check_privacy_settings 2>&1)" || status=$?
report "Caddy keeps admin off and discards every log"

status=0
out="$(check_hsts 2>&1)" || status=$?
report "Caddy sends Strict-Transport-Security: $HSTS, on error responses too"

status=0
out="$(check_security_headers 2>&1)" || status=$?
report "Caddy sends the CSP and no Server header, on error responses too, which echo nothing"

status=0
out="$(verify_units 2>&1)" || status=$?
report "systemd-analyze verify (${UNITS[*]})"

status=0
out="$(check_preview_csp 2>&1)" || status=$?
report "vite preview serves the Caddyfile's CSP"

exit "$failed"
