FROM --platform=$BUILDPLATFORM golang:1.26.4-bookworm@sha256:b305420a68d0f229d91eb3b3ed9e519fcf2cf5461da4bef997bf927e8c0bfd2b AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src/services/telegram-bot
COPY services/telegram-bot/go.mod ./
COPY services/telegram-bot ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/raven-telegram-bot ./cmd/raven-telegram-bot

FROM debian:12-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/raven-telegram-bot /usr/local/bin/raven-telegram-bot
LABEL org.opencontainers.image.title="Raven Telegram bot" \
      org.opencontainers.image.description="Turns Telegram stickers and GIFs into .ravenpack files." \
      org.opencontainers.image.source="https://github.com/raven-collective/raven-prototype"
# Scratch space for drafts; nonroot owns it so a fresh named volume is writable.
RUN mkdir -p /var/lib/raven-bot && chown 65532:65532 /var/lib/raven-bot
VOLUME /var/lib/raven-bot
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/raven-telegram-bot"]
