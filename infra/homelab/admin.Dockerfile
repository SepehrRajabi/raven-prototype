FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS build

WORKDIR /src
COPY apps/admin/package.json apps/admin/bun.lock ./
RUN bun install --frozen-lockfile
COPY apps/admin ./
RUN bun run build

# nginx-unprivileged runs every nginx process as uid 101 instead of root, so it listens
# on 8080.
FROM nginxinc/nginx-unprivileged:1.30-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03

ARG RAVEN_VERSION=0.0.0
LABEL org.opencontainers.image.title="Raven admin dashboard"       org.opencontainers.image.description="Static admin dashboard for a Raven server. Serve it beside the API."       org.opencontainers.image.version=$RAVEN_VERSION       org.opencontainers.image.source="https://github.com/raven-collective/raven-prototype"

COPY infra/homelab/admin-security-headers.conf /etc/nginx/admin-security-headers.conf
COPY infra/homelab/admin-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
