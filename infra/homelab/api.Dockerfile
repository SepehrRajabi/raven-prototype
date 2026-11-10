FROM --platform=$BUILDPLATFORM golang:1.26.4-bookworm@sha256:b305420a68d0f229d91eb3b3ed9e519fcf2cf5461da4bef997bf927e8c0bfd2b AS build

ARG TARGETOS=linux
ARG TARGETARCH=amd64
WORKDIR /src/services/api
COPY services/api/go.mod services/api/go.sum ./
# The default module proxy refuses some downloads from some networks. "|" moves on to the
# next source after any failure; go.sum still checks every module that arrives.
ARG GOPROXY=https://proxy.golang.org|https://goproxy.cn|direct
ENV GOPROXY=${GOPROXY}
RUN go mod download
COPY services/api ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/raven-api ./cmd/raven-api

# GIF and sticker conversion needs ffmpeg. Debian's package pulls in ~440 MB of codecs and
# libraries Raven never uses, so this builds one with only what library_assets.go calls:
# the GIF, MP4, WebM, PNG and WebP readers, the H.264/HEVC/VP8/VP9/GIF/PNG/WebP decoders,
# libvpx-vp9 and libwebp encoders, and the scale/fps/format filters. HEVC also avoids a
# 7.1 link error (ff_aom_uninit_film_grain_params) in builds with H.264 alone.
FROM debian:12-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df AS ffmpeg

ARG FFMPEG_VERSION=7.1.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget xz-utils build-essential nasm pkg-config libvpx-dev libwebp-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN wget -q https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz && tar xf ffmpeg-${FFMPEG_VERSION}.tar.xz
WORKDIR /src/ffmpeg-${FFMPEG_VERSION}
RUN ./configure --prefix=/opt/ffmpeg --disable-everything --disable-doc --disable-debug --disable-network \
      --disable-autodetect --disable-ffplay --enable-libvpx --enable-libwebp \
      --enable-protocol=file,pipe \
      --enable-demuxer=gif,mov,matroska,png_pipe,webp_pipe \
      --enable-muxer=webm,webp \
      --enable-decoder=gif,h264,hevc,vp8,vp9,libvpx_vp8,libvpx_vp9,png,webp \
      --enable-encoder=libvpx_vp9,libwebp,libwebp_anim \
      --enable-parser=h264,hevc,vp8,vp9,png,webp,gif \
      --enable-filter=scale,fps,format,null,setsar,trim \
      --enable-bsf=vp9_superframe \
    && make -j"$(nproc)" && make install \
    && strip /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe

FROM debian:12-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates wget libvpx7 libwebp7 libwebpmux3 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=build /out/raven-api /usr/local/bin/raven-api
ARG RAVEN_VERSION=0.0.0
ENV RAVEN_VERSION=$RAVEN_VERSION
LABEL org.opencontainers.image.title="Raven API"       org.opencontainers.image.description="The Raven server: accounts, spaces, rooms, chat and LiveKit call tokens."       org.opencontainers.image.version=$RAVEN_VERSION       org.opencontainers.image.source="https://github.com/raven-collective/raven-prototype"
# Local-disk media for self-hosters (RAVEN_MEDIA_DIR); nonroot owns it so a fresh named volume is writable.
RUN mkdir -p /var/lib/raven/media && chown 65532:65532 /var/lib/raven/media
VOLUME /var/lib/raven/media
USER 65532:65532
EXPOSE 6977
ENTRYPOINT ["/usr/local/bin/raven-api"]

