# Raven API

Raven is a voice-first place to hang out with your friends: calls, screen and camera
sharing, and chat, in a native desktop app. This image is Raven's **server API**. Run it
with PostgreSQL, Redis and LiveKit, then sign in from the official desktop client by entering
your server's address.

The admin dashboard is a separate image: `soroushtaheri/raven-admin`.

## Quick start

Full guide, reverse-proxy example and backups:
<https://github.com/raven-collective/raven-prototype/blob/main/docs/self-hosting.md>

```bash
# compose.yaml, .env.example and nginx.example.conf are in infra/self-host/
cp .env.example .env      # fill in the secrets, public IP and LiveKit URL
docker compose up -d
docker compose run --rm api user create --username alice --password '...' --role admin
```

## Image

- Go binary, listens on port `6977` (plain HTTP: put a TLS-terminating reverse proxy in front).
- Runs as UID `65532`. Media is stored under the volume `/var/lib/raven/media`.
- Health check: `GET /healthz`.
- Database migrations run when the API starts.
- Built for `linux/amd64` and `linux/arm64`. Tags: `X.Y.Z` (a release) and `latest`.

## Environment

| Variable | Meaning |
|---|---|
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_SSLMODE` | Database connection (with `RAVEN_DATABASE_DRIVER=postgres`) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Public LiveKit address and key pair |
| `RAVEN_MEDIA_DIR` | Directory for profile and chat images (mount a volume; compose uses `/var/lib/raven/media`) |
| `RAVEN_MINIMUM_CLIENT_VERSION` | Older desktop clients are asked to update |
| `RAVEN_SERVER_NAME`, `RAVEN_SERVER_DESCRIPTION` | Shown on the sign-in screen |
| `RAVEN_TRUSTED_PROXIES` | Proxy addresses (CIDR list) whose `X-Forwarded-For` is believed |
| `RAVEN_LINK_PREVIEWS` | `on` lets the server read the pages people link to in chat, for link previews (public addresses only). Off by default |
| `RAVEN_API_ADDR` | Listen address, default `0.0.0.0:6977` in compose |

## Command line

The same image manages accounts and spaces:

```bash
docker compose run --rm api user create --username <name> --password '<pw>' --role admin
docker compose run --rm api user set-role --username <name> --role admin
docker compose run --rm api user reset-password --username <name>
docker compose run --rm api space create --name <space> --creator <name>
```
