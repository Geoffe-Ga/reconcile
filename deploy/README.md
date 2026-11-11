# Deploy: one VM, logging off

The pilot runs on one small DigitalOcean droplet that serves the app and the relay over HTTPS from one origin ([ADR-0041](../docs/adr/0041-digitalocean-relay-hosting.md)). There is one VM, with no staging, no CI deploys and no deploy key in GitHub ([ADR-0073](../docs/adr/0073-mvp-scope.md)). The founder deploys it from their own machine with `deploy/deploy.sh`, which smoke-tests every deploy. The relay itself is described in [`docs/spec/phase-1-spec.md`](../docs/spec/phase-1-spec.md) §6, and its privacy rules in §9.

| File | What it does |
|---|---|
| [`Caddyfile`](Caddyfile) | TLS, HSTS, the CSP, `/v1/*` to the relay on `127.0.0.1:8787`, everything else from `/srv/reconcile/app` (the manifest with its own `Content-Type`). Caddy's own error responses get the same headers and a fixed body. Every log goes to discard |
| [`reconcile-relay.service`](reconcile-relay.service) | The relay under Uvicorn, as the `reconcile` user, with no access log, no proxy headers and no `Server` header. It points at the VAPID key that signs Web Push ([below](#web-push)) |
| [`reconcile-purge.service`](reconcile-purge.service), [`reconcile-purge.timer`](reconcile-purge.timer) | Deletes expired blobs daily (30-day retention, [ADR-0057](../docs/adr/0057-environments-updates-retention.md)), and backups 180 days after their last refresh (#97) |
| [`deploy.sh`](deploy.sh) | Builds, syncs, installs, restarts and smoke-tests. Run it with `--help` for the steps |
| [`smoke.sh`](smoke.sh) | Health, a 1 KiB PUT and a GET back, a 64 KiB backup PUT and GET back (#97), then the push key, against any base URL |
| [`check.sh`](check.sh) | Validates the Caddyfile and the units. CI runs it through `./scripts/check-all.sh --deploy` |
| [`no-ip-check.sh`](no-ip-check.sh) | Tries to make Caddy or the relay, with push on, write a client IP. Run it locally before changing either |

## One-time setup

The founder does this once. The `<placeholders>` are yours; never commit their values.

**1. The droplet.** Create an **Ubuntu 24.04 LTS** droplet, the smallest size, in a US region, with your SSH key.
- Leave **Monitoring** unticked: it installs a metrics agent.
- Turn **Backups** off, and don't take **snapshots**. Either would keep the relay's database past its retention: 30 days for blobs, and 180 days after the last refresh for relay backups (#97).

**2. DNS.** Point an **A record** for `<domain>` at the droplet's IPv4 address. Caddy gets its certificate for that name on the first deploy.

**3. SSH: key only, no root.** As root, make a `deploy` user with sudo:

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
passwd deploy          # sudo asks for this during each deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' \
  > /etc/ssh/sshd_config.d/10-reconcile.conf
systemctl restart ssh
```

Check that `ssh deploy@<vm>` works from a second terminal before you log out as root.

**4. Updates, firewall and logs.** As `deploy`, with sudo:

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades python3-venv rsync
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

sudo ufw allow 22,80,443/tcp
sudo ufw logging off
sudo ufw enable

# Keep the journal in memory only, and stop rsyslog copying it to disk.
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\n' | sudo tee /etc/systemd/journald.conf.d/volatile.conf
sudo systemctl restart systemd-journald
sudo rm -rf /var/log/journal
sudo apt-get purge -y rsyslog
sudo rm -f /var/log/syslog* /var/log/auth.log* /var/log/kern.log*
```

`journald` `Storage=volatile` alone isn't enough on Ubuntu: rsyslog would still write `syslog` and `auth.log` to disk.

**5. Caddy, from its own apt repository.** These are [Caddy's install steps](https://caddyserver.com/docs/install#debian-ubuntu-raspbian):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

The first deploy replaces its default Caddyfile.

**6. The relay's user, directories and venv.** The relay runs as `reconcile`, which can read its code but not change it. Its database lives in `/var/lib/reconcile`, which systemd creates (`StateDirectory=`) and only `reconcile` can read.

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin reconcile
sudo install -d -m 755 /opt/reconcile /srv/reconcile
sudo install -d -m 755 -o deploy -g deploy /opt/reconcile/src /opt/reconcile/venv /srv/reconcile/app
python3 -m venv /opt/reconcile/venv
```

**7. Your machine.** You need Node (the version in `client/.nvmrc`), `git`, `rsync`, `curl` and `ssh`, with your key in `ssh-agent`. Put the two settings in `deploy/.env`, which git ignores, or export them:

```bash
RECONCILE_DEPLOY_HOST=deploy@<vm>
RECONCILE_SITE=<domain>
```

## Deploying

```
$ deploy/deploy.sh
deploy: <commit> to <domain>
…the client build…
[sudo] password for deploy:
built client · synced · restarted reconcile-relay
smoke: health ok · put seq 1 · get matches · backup matches · push key · PASS
```

It exits non-zero if any step fails, including the smoke test. The VM's own Caddy validates the Caddyfile before anything restarts. A deploy restarts Caddy, because `admin off` disables `caddy reload`, so the app is down for a second or two. On the first deploy the script waits up to two minutes for Caddy's certificate.

**Until #71, the relay stores the tracer's events in plaintext.** Use throwaway text only on the phone run.

After the first deploy, the founder runs the loop over HTTPS between an iPhone and a second device. Record the result on #68, and file each failure as its own issue.

## Web Push

The relay wakes opted-in phones with empty pushes ([ADR-0012](../docs/adr/0012-content-free-push.md), #89; the app's switch is #99). Each push is signed with the relay's VAPID key ([RFC 8292](https://www.rfc-editor.org/rfc/rfc8292)), which phones subscribe with, so there is nothing for the founder to set up:

- **The key lives only on the VM,** at `/var/lib/reconcile/vapid.pem`, readable only by `reconcile`. The first deploy makes it with `openssl ecparam -name prime256v1 -genkey -noout`, as `reconcile` with umask 077. Later deploys see it there and leave it alone. Nothing copies it off the VM, and it never enters git. Ubuntu ships `openssl`, so step 4 needs nothing new.
- **A rebuilt VM means new subscriptions.** A new VM gets a new key, which every subscription made with the old one won't accept. The app notices that `/v1/push/key` changed and subscribes again the next time it opens (#99), so phones that aren't opened stay quiet until they are. Don't carry the old key across to avoid this: a copy kept off the VM is one more place it can leak from, and whoever holds it and an endpoint can wake that phone.
- **The subject** is `https://<domain>`, set by a drop-in that `deploy.sh` writes (`/etc/systemd/system/reconcile-relay.service.d/reconcile.conf`). Push services see it on every push and may refuse one that names `localhost` or an IP address, so the relay won't start with either.
- **The relay calls out.** Its only outbound requests are these pushes, over HTTPS to Apple, Google, Mozilla or Microsoft, and only to an endpoint on one of their push services. `ufw` lets outbound traffic through by default, so the firewall step needs no change.

To try push against `./scripts/relay.sh`, make a throwaway key and pass both settings:

```bash
(umask 077 && openssl ecparam -name prime256v1 -genkey -noout -out .relay-data/vapid.pem)
RECONCILE_RELAY_VAPID_KEY=.relay-data/vapid.pem RECONCILE_RELAY_VAPID_SUBJECT=https://<domain> ./scripts/relay.sh
```

## Checks

- **`deploy/check.sh`** runs in CI whenever `deploy/` or `client/vite.config.ts` changes. It needs `caddy` (`sudo apt-get install -y caddy` on Ubuntu) and `systemd-analyze`, so it runs on Linux only. It verifies our three units alone (`--recursive-errors=no`, in a temp root holding nothing else), so the host's own units can't fail it. Any warning about them fails, because systemd ignores a misspelled setting rather than refusing it. It also holds the Caddyfile's CSP and HSTS header to their values, on the site's routes and on [its error routes](#caddys-own-errors) (see [The CSP](#the-csp) and [HSTS](#hsts)).
- **`deploy/no-ip-check.sh`** runs locally, with `.venv` active and `caddy`, `curl` and `openssl` on your PATH. It starts the relay with the unit's flags and push on, and Caddy with this Caddyfile, both on unprivileged ports, and sends normal, malformed and failing requests from `127.0.0.2`, push and backup routes included. Nothing it sends makes the relay call a push service. Then it searches Caddy's and Uvicorn's output and the SQLite files for that address and for canary values sent in forwarding headers. It also checks that the 502 Caddy writes while the relay is down carries the app's security headers and a body that names nothing. On macOS, first run `sudo ifconfig lo0 alias 127.0.0.2`.
- **`deploy/smoke.sh <base-url>`** works against any running relay with push on, such as `http://127.0.0.1:8787` from `./scripts/relay.sh` started [with a key](#web-push). Without one, it fails at its last step, `push`.

## What the VM still sees

Nothing is written to disk but the relay's database and its VAPID key. Anyone who controls the VM, or the DigitalOcean account, can still watch it live and see:
- the IP address of each connecting device;
- the timing and size of every request;
- which mailboxes one device polls. It polls all of its groups from one address every few seconds, which ties those groups together ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §2);
- SSH logins (the founder's), in the in-memory journal until the next reboot. The system's login records in `/var/log/wtmp`, `btmp` and `lastlog` also keep them on disk.

Push adds to that, in the database for up to 30 days ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §2, #130):
- **each opted-in phone's push endpoint,** under every mailbox where it's on. One phone has one endpoint, so the database shows which groups share a phone, and Apple or Google could tie that endpoint to a person;
- **the minutes a mailbox is due a wake,** which show which blobs mattered and when votes close.

The push services see the VM's address, and when each phone is woken, but never anything about the group: the push is empty.

## The CSP

Caddy sends this header on every response, and `vite preview` sends the same one ([`client/vite.config.ts`](../client/vite.config.ts)). The hash is shortened here; the [Caddyfile](Caddyfile) has it in full:

```
default-src 'self'; script-src 'self'; style-src-elem 'self' 'sha256-…'; connect-src 'self' https://discord.com/api/webhooks/; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

This CSP and #70's Markdown sanitizer are the main defense against injected script stealing keys. The page can load script only from its own origin: no inline script, no third party, no plugins. No `<base>` tag can redirect its URLs, and no other site can frame it.

**One more place to connect, by its path (#119).** `connect-src` lets the page reach its own origin, where the relay is, and Discord's webhooks, `https://discord.com/api/webhooks/` and nothing else on any host. A group's chat bot posts its content-free notices there once the group turns it on by Proposal ([ADR-0074](../docs/adr/0074-mvp-scope-revised.md)); the webhook URL lives only in the group's sealed events. A static header can't name one group's webhook, so the path allows every webhook, an attacker's own included. That gives a script that got injected one more place to send what it reads, as a relay mailbox of its own choosing already did. Keeping script from being injected (`script-src` and the sanitizer) stays the defense; `connect-src` keeps every other host out:
- `client/src/net/discord.ts` is the only code that posts there. It rebuilds each webhook URL on `discord.com`, so a `discordapp.com` one works too, and sends `redirect: 'error'`, because a CSP path check doesn't hold across a redirect.
- `client/src/net/discord.test.ts` pins the directive, and `client/e2e/csp.spec.ts` posts to the webhook path under this CSP and expects a `securitypolicyviolation` for another host, another Discord path and `discordapp.com`.

**One inline style, by its hash (#153).** On iOS and iPadOS, React Aria inserts a `<style>` with one fixed rule, `@layer { * { overscroll-behavior: contain; } }`, while a Modal or a modal Popover (Select, ComboBox, Menu, DatePicker) is open, so scrolling inside the overlay doesn't scroll the page behind it. It has no id, so it can't be claimed the way the pressable style is (#150). `style-src-elem` allows `<style>` and stylesheet elements from `'self'`, plus that one text by the SHA-256 hash of its exact bytes, and nothing else:
- It isn't `'unsafe-inline'`. An injected `<style>` with any other text is still blocked, `style` attributes still fall back to `default-src 'self'`, and script is untouched.
- Every browser [ADR-0042](../docs/adr/0042-broad-device-support.md) supports understands `style-src-elem` (since Safari 15.4, Chromium 75 and Firefox 108). An older one ignores it and falls back to `default-src 'self'`, which blocks the style: it fails closed.
- `client/src/styles/scrollLockStyle.test.tsx` hashes the text the installed React Aria injects and fails if the CSP's hash differs, so an upgrade that changes it can't ship silently. `client/e2e/ios-scroll-lock.spec.ts` opens a Modal as an iPhone under this CSP and under the same CSP without the hash, and expects no violation and then the violation.

To change the CSP, change both files: `deploy/check.sh` fails when they differ. Since the CSP allows no `data:` URLs, the client build inlines no assets (`build.assetsInlineLimit: 0`).

## HSTS

Caddy also sends this header on every HTTPS response:

```
Strict-Transport-Security: max-age=31536000
```

Caddy answers a plain-HTTP request with a redirect to HTTPS, but the request itself travels in plaintext, so anyone on the network path can answer it instead and keep the browser on HTTP. HSTS tells a browser that has reached the site over HTTPS to use only HTTPS here for the next year, counted again from each visit. After that first visit, a typed or bookmarked `http://` address never leaves the device in plaintext. The very first visit from a device is still exposed.

The header leaves out two directives on purpose:
- **`includeSubDomains`** would also force HTTPS, for a year, on every name under `RECONCILE_SITE`. If the site is a domain's apex, that means every subdomain, including any the founder doesn't run or that serve only HTTP. Add it only if the founder owns the whole domain for Reconcile.
- **`preload`** asks browsers to build the domain into their HTTPS-only list, which would protect the first visit too. The list requires `includeSubDomains`, and leaving it takes months, while the pilot's domain may still change.

`vite preview` doesn't send it: preview serves plain HTTP, where browsers ignore the header. To change the value, change it in the Caddyfile and in `HSTS` in `deploy/check.sh`: the check fails when they differ.

## Caddy's own errors

Caddy writes some responses itself, such as a 502 while the relay is down. Those skip the site's routes, and with them its `header` block, so the Caddyfile keeps its headers in one `(security_headers)` snippet that the site and its `handle_errors` block both import. An error response therefore carries the same CSP and HSTS header, and no `Server` header. Its body is one fixed sentence: it repeats nothing from the request or the relay's error, so it can't reflect a canary or reveal the upstream's address.

`deploy/check.sh` fails if the error routes lose a header, set one twice or fill in any placeholder, and `deploy/no-ip-check.sh` checks a real 502 (#159).

## Not here

Staging, CI deploys, deploy keys in GitHub and containers wait until after the MVP (ADR-0073 amends ADR-0041's container). So do log shipping, metrics and uptime pings. Real encryption is #71.

## The installable app

The build includes the web app manifest and the service worker, `/sw.js`, which keeps the app on each device so it opens offline (#76, spec §7). Both are plain files from the app's own origin, so the CSP needs no change. The worker never caches `/v1`. A deploy reaches each device in the background and applies the next time the app opens after every Reconcile window has closed: testers update by closing the app and opening it again.
