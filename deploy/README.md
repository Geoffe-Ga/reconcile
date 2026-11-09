# Deploy: one VM, logging off

The pilot runs on one small DigitalOcean droplet that serves the app and the relay over HTTPS from one origin ([ADR-0041](../docs/adr/0041-digitalocean-relay-hosting.md)). There is one VM, with no staging, no CI deploys and no deploy key in GitHub ([ADR-0073](../docs/adr/0073-mvp-scope.md)). The founder deploys it from their own machine with `deploy/deploy.sh`, which smoke-tests every deploy. The relay itself is described in [`docs/spec/phase-1-spec.md`](../docs/spec/phase-1-spec.md) §6, and its privacy rules in §9.

| File | What it does |
|---|---|
| [`Caddyfile`](Caddyfile) | TLS, HSTS, the CSP, `/v1/*` to the relay on `127.0.0.1:8787`, everything else from `/srv/reconcile/app`. Every log goes to discard |
| [`reconcile-relay.service`](reconcile-relay.service) | The relay under Uvicorn, as the `reconcile` user, with no access log, no proxy headers and no `Server` header |
| [`reconcile-purge.service`](reconcile-purge.service), [`reconcile-purge.timer`](reconcile-purge.timer) | Deletes expired blobs daily (30-day retention, [ADR-0057](../docs/adr/0057-environments-updates-retention.md)) |
| [`deploy.sh`](deploy.sh) | Builds, syncs, installs, restarts and smoke-tests. Run it with `--help` for the steps |
| [`smoke.sh`](smoke.sh) | Health, then a 1 KiB PUT and a GET back, against any base URL |
| [`check.sh`](check.sh) | Validates the Caddyfile and the units. CI runs it through `./scripts/check-all.sh --deploy` |
| [`no-ip-check.sh`](no-ip-check.sh) | Tries to make Caddy or the relay write a client IP. Run it locally before changing either |

## One-time setup

The founder does this once. The `<placeholders>` are yours; never commit their values.

**1. The droplet.** Create an **Ubuntu 24.04 LTS** droplet, the smallest size, in a US region, with your SSH key.
- Leave **Monitoring** unticked: it installs a metrics agent.
- Turn **Backups** off, and don't take **snapshots**. Either would keep the relay's database past its 30 days.

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
smoke: health ok · put seq 1 · get matches · PASS
```

It exits non-zero if any step fails, including the smoke test. The VM's own Caddy validates the Caddyfile before anything restarts. A deploy restarts Caddy, because `admin off` disables `caddy reload`, so the app is down for a second or two. On the first deploy the script waits up to two minutes for Caddy's certificate.

**Until #71, the relay stores the tracer's events in plaintext.** Use throwaway text only on the phone run.

After the first deploy, the founder runs the loop over HTTPS between an iPhone and a second device. Record the result on #68, and file each failure as its own issue.

## Checks

- **`deploy/check.sh`** runs in CI whenever `deploy/` or `client/vite.config.ts` changes. It needs `caddy` (`sudo apt-get install -y caddy` on Ubuntu) and `systemd-analyze`, so it runs on Linux only. It verifies our three units alone (`--recursive-errors=no`, in a temp root holding nothing else), so the host's own units can't fail it. Any warning about them fails, because systemd ignores a misspelled setting rather than refusing it. It also holds the Caddyfile's CSP and HSTS header to their values (see [The CSP](#the-csp) and [HSTS](#hsts)).
- **`deploy/no-ip-check.sh`** runs locally, with `.venv` active and `caddy` and `curl` on your PATH. It starts the relay with the unit's flags and Caddy with this Caddyfile, both on unprivileged ports, and sends normal, malformed and failing requests from `127.0.0.2`. Then it searches Caddy's and Uvicorn's output and the SQLite files for that address and for canary values sent in forwarding headers. On macOS, first run `sudo ifconfig lo0 alias 127.0.0.2`.
- **`deploy/smoke.sh <base-url>`** works against any running relay, such as `http://127.0.0.1:8787` from `./scripts/relay.sh`.

## What the VM still sees

Nothing is written to disk. Anyone who controls the VM, or the DigitalOcean account, can still watch it live and see:
- the IP address of each connecting device;
- the timing and size of every request;
- which mailboxes one device polls. It polls all of its groups from one address every few seconds, which ties those groups together ([ADR-0075](../docs/adr/0075-safeguards-for-the-revised-mvp.md) §2);
- SSH logins (the founder's), in the in-memory journal until the next reboot. The system's login records in `/var/log/wtmp`, `btmp` and `lastlog` also keep them on disk.

## The CSP

Caddy sends this header on every response, and `vite preview` sends the same one ([`client/vite.config.ts`](../client/vite.config.ts)):

```
default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

This CSP and #70's Markdown sanitizer are the main defense against injected script stealing keys. The page can load script only from its own origin: no inline script, no third party, no plugins. No `<base>` tag can redirect its URLs, and no other site can frame it.

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

## Not here

Staging, CI deploys, deploy keys in GitHub and containers wait until after the MVP (ADR-0073 amends ADR-0041's container). So do log shipping, metrics and uptime pings. The installable PWA and its iOS install gate are #76, and real encryption is #71.
