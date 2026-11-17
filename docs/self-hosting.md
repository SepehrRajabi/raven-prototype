# Hosting your own Raven server

Run Raven for your friends or team on your own machine, and sign in from the official
desktop client by typing your server's address. The server is two Docker images
(`soroushtaheri/raven-api`, `soroushtaheri/raven-admin`) plus PostgreSQL, Redis and
LiveKit from their official images. Profile pictures and chat images are stored on a Docker
volume; no S3 is needed.

## What you need

- A Linux machine (amd64 or arm64) with a public IP address, Docker and Docker Compose v2.
- Three DNS names pointing at it, for example `raven.example.org` (API),
  `rtc.example.org` (calls) and `admin.example.org` (dashboard).
- A reverse proxy on that machine that terminates TLS. The example below uses nginx and
  certbot; any proxy that supports WebSockets and streaming responses works.
- Open to the internet: `443/tcp`, `7881/tcp` and `50002-50100/udp` (call media). Port `80/tcp`
  too if certbot uses it.

## Set up

1. Copy `infra/self-host/compose.yaml`, `.env.example` and `nginx.example.conf` to a folder on
   the server, and rename `.env.example` to `.env`.
2. Edit `.env`. Make each `change-me` a fresh secret (`openssl rand -hex 32`), set
   `LIVEKIT_NODE_IP` to the machine's public IP and `LIVEKIT_URL` to `wss://rtc.example.org`.
3. Start the stack:

   ```bash
   docker compose up -d
   docker compose ps          # every service should become "healthy"
   ```

   Database tables are created and migrated by the API itself on every start.
4. Put the proxy in front. Copy `nginx.example.conf` into nginx's `conf.d`, replace the three
   `example.org` names, create the dashboard password
   (`htpasswd -c /etc/nginx/raven.htpasswd <name>`), reload nginx and run
   `certbot --nginx -d raven.example.org -d rtc.example.org -d admin.example.org`.
   Check `https://raven.example.org/healthz` answers.

   The example sends the API the address nginx saw (`X-Forwarded-For $remote_addr`) and
   drops any `X-Forwarded-For` a client sent, because the API believes the leftmost
   address in that header: passing a client's own header on would let anyone choose the
   address used for sign-in throttling and shown beside their sessions. If something sits
   in front of nginx (a CDN or another proxy), keep those lines and add that hop's ranges
   with nginx's `set_real_ip_from`, as the comment at the top of the file shows. The
   example also sends `Strict-Transport-Security`, `X-Content-Type-Options: nosniff` and
   `X-Frame-Options: DENY`.
5. Create the first administrator and a space (the people's group):

   ```bash
   docker compose run --rm api user create --username alice --password '<a long password>' --role admin
   docker compose run --rm api space create --name "My space" --creator alice
   docker compose run --rm api user create --username bob --password '<password>'
   docker compose run --rm api space add-user --space "My space" --username bob
   ```

   A password given with `--password` is visible in the process list and the shell history.
   Leave the flag out and `user create` reads the password from standard input instead:
   `printf '%s\n' "$PASSWORD" | docker compose run --rm -T api user create --username bob`.
   The API also refuses to start when `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` is unset and it
   listens on anything but loopback, since the development pair would let anyone sign call tokens.

6. Install Raven from <https://updates.rvn.bluehour.cloud> (the official client), fill in
   the "Server address" field on the sign-in screen, enter `https://raven.example.org` and sign in.

## The dashboard

`https://admin.example.org` asks for the proxy password first, then for a Raven administrator
sign-in. See `docs/permissions.md` for what roles can do.

## Upgrading

`RAVEN_IMAGE_TAG` in `.env` names the release you run (`compose.yaml` falls back to the
release it was written for). Set it to the new release, then:

```bash
docker compose pull
docker compose up -d
```

Back up first. Migrations run when the API starts and are not reversible by downgrading the
image. `RAVEN_MINIMUM_CLIENT_VERSION` makes older desktop clients ask their user to update;
raise it only after the new client is out.

## Backups

Two things hold your data: the database and the `raven_media` volume.

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump --username raven --dbname raven --format custom > backups/raven-$(date -u +%Y%m%dT%H%M%SZ).dump
docker run --rm -v "$(basename "$PWD")_raven_media:/media:ro" -v "$PWD/backups:/out" debian:12-slim \
  tar -czf /out/raven-media-$(date -u +%Y%m%d).tar.gz -C /media .
```

(The volume is named `<folder>_raven_media`; check with `docker volume ls`.) Copy the files off
the machine. Restore a dump with `pg_restore --clean --dbname raven` inside the `postgres`
container, and unpack the media archive back into the volume.

## Storage limits per person

Rate limits bound how fast one account can store files; these bound how much it can keep.
Set them in the `api` service's environment and restart it. `0` turns a limit off.

| Variable | Default | |
|---|---|---|
| `RAVEN_CHAT_PENDING_MB` | 256 | images a person has uploaded but not yet sent, in MB (declared size, previews included). Unsent uploads expire after a day. |
| `RAVEN_LIBRARY_MAX_ITEMS` | 1000 | GIFs and stickers in one library: a person's own, or a space's set |
| `RAVEN_LIBRARY_UPLOAD_MB` | 512 | stored size of the GIFs and stickers a person uploaded, in MB. Adding one somebody else already uploaded costs nothing. |

Sent attachments are not counted. They stay as long as their messages do.

## Port sharing (Workshop)

Port sharing lets people in a call or room share a local TCP or UDP port with each other, relayed through your server. It is off until you turn it on, and the server never dials anything itself: it only joins two Raven clients.

Environment variables for the `api` service:

| Variable | Default | |
|---|---|---|
| `RAVEN_WORKSHOP_PORTS` | off | `on` turns the feature on |
| `RAVEN_RELAY_QUIC_ADDR` | none | UDP address of the QUIC relay, for example `:7443` |
| `RAVEN_RELAY_TLS_CERT`, `RAVEN_RELAY_TLS_KEY` | none | PEM files for the relay hostname |
| `RAVEN_RELAY_ENDPOINTS` | none | routes clients try, in order, comma-separated, for example `quic://relay.example.org:7443,wss://raven.example.org/v1/relay/ws`. After a URL, space-separated notes the app shows on the route line: `behind-cdn` (a CDN ends TLS in front of the relay) and `origin-http` (the CDN reaches your server over plain HTTP) |
| `RAVEN_WORKSHOP_MAX_SHARES` | 3 | active shares per person |
| `RAVEN_WORKSHOP_MAX_CONSUMERS` | 8 | people connected to one share |
| `RAVEN_WORKSHOP_MAX_FLOWS` | 16 | open TCP connections plus UDP flows per person per share |
| `RAVEN_WORKSHOP_SHARE_MBPS` | 20 | bandwidth per share, both directions together |
| `RAVEN_WORKSHOP_DAILY_GB` | 20 | traffic per person per UTC day (kept in memory; a restart resets it) |
| `RAVEN_WORKSHOP_MAX_MINUTES` | 720 | longest a share may last (the default is 120) |
| `RAVEN_WORKSHOP_MAX_PENDING` | 512 | relay connections (QUIC and WebSocket together) that may be waiting to sign in at once |
| `RAVEN_WORKSHOP_MAX_PENDING_PER_IP` | 16 | of those, how many may come from one address; further ones are closed (QUIC) or answered `503` (WebSocket) |

Things to know:

- **Open the QUIC port.** QUIC is UDP. Open `RAVEN_RELAY_QUIC_ADDR`’s port in your firewall and map it in compose (`7443:7443/udp`).
- **The certificate must be publicly trusted** (for example Let’s Encrypt) for the relay hostname, because clients verify it against the usual root certificates. The API reads it once at start; restart `api` after renewing.
- **Keep the relay hostname out of a CDN.** CDNs generally don’t proxy raw QUIC, so use a DNS-only record. A CDN that did proxy it would end TLS and could read every forwarded byte, and many CDNs have idle timeouts and terms that forbid bulk traffic.
- **The WebSocket route** is for people whose network blocks UDP. It is the API's own `/v1/relay/ws` over HTTPS, so it works through a CDN. Your reverse proxy must pass the WebSocket upgrade for that path and allow a long read timeout (shares last up to 12 h; the relay pings every 20 s). The app races the routes, starting QUIC first and the next one 300 ms later. If a CDN ends TLS, or reaches you over plain HTTP, declare it with the notes above: Raven can't detect either, and people are told only what you declare.
- Until end-to-end encryption exists, you, as the operator, can read the bytes that pass through. The app tells people so.
- A restart ends every share; clients show "The relay restarted. Share the port again."
- The two capabilities `workshop.share_ports` and `workshop.use_ports` are allowed by default and can be changed per account in the admin dashboard.

## Troubleshooting

- **"Server unreachable" on the sign-in screen**: the proxy or certificate is wrong. Open
  `https://raven.example.org/healthz` in a browser; check `docker compose ps` and the proxy log.
- **Calls connect but nobody hears anyone**: UDP `50002-50100` and TCP `7881` are blocked, or
  `LIVEKIT_NODE_IP` is not the machine's public IP. Behind a home router, forward those ports.
- **Calls never connect**: `LIVEKIT_URL` must be the public `wss://` name of the `rtc` proxy
  block, and the proxy must pass WebSocket upgrades.
- **Everyone appears to come from one address / sign-in throttling hits everybody**: the proxy
  is outside the ranges in `RAVEN_TRUSTED_PROXIES` (default: private ranges). Set it in the
  `api` environment to the proxy's address.
- **Logs**: `docker compose logs -f api`.
