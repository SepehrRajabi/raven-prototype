# Raw video frames instead of JPEG

## Context

Measured on 2026-11-13 with a release build and the production frontend, in a call with 4 remote 720p30 videos:
- Rust used 73% of one core. About 33% of that is JPEG encoding (`presentEncodeMs` 2.6 ms per frame) and the rest is libvpx decoding.
- The WebView used 35%: 19% in the renderer decoding the JPEGs, 14% in the GPU process. The GPU process's private memory grew from 85 MB to about 470 MB.

Today every decoded frame goes I420 → resize → mozjpeg → loopback MJPEG → `<img>` → decode → GPU. The aim is to send the resized I420 planes as they are and draw them with a WebGL2 shader. That removes the JPEG encode in Rust and the JPEG decode in the WebView. MJPEG stays as a fallback for when WebGL2 can't be used (Soroush's choice). Hardware video decoding is a separate job and not part of this plan.

Invariants to keep (from `video-engine.md`):
- Frames never cross Tauri's JSON bridge.
- A tile that is not shown costs nothing.
- A slow WebView drops frames instead of building a queue.
- The presentation limits (`limits_for`) still cap the size and frame rate the page receives.

## Design

**Wire.** The loopback service in `video/stream.rs` gains a second suffix next to `.mjpg`:
- `GET /<token>/<streamId>.i420` returns `application/octet-stream`.
- The body is a stream of frames. Each frame is a 16-byte little-endian header (`RVF1`, width u32, height u32, payload length u32) followed by the tight Y, U and V planes.
- Width and height are kept even, as I420 requires.
- Both routes add `Access-Control-Allow-Origin: *`, because `fetch` needs it and `<img>` does not. The random token in the path remains the access control.
- The `.i420` route also sets a small send buffer on the socket (about one frame). Otherwise the kernel would hold stale frames and add latency.

**Hub.** Each subscriber in `VideoFrameHub` gets a format (`Raw` or `Jpeg`).
- `publish` sends each packet only to subscribers of its format.
- A new `has_subscribers_for(stream, format)` lets the worker produce only what someone is watching.
- The worker in `VideoFramePublisher::new` resizes once, using the existing logic in `encode_frame` (split out as `prepare_frame`). It then does either or both of:
  - packs the planes into a frame, if there are raw subscribers;
  - JPEG-encodes, if there are JPEG subscribers.
- `encode_micros` keeps measuring JPEG time only. `shown` counts frames of either format.

**Page.** A new `components/media/VideoSurface.tsx` (canvas) replaces both `<img>` elements.
- It opens `fetch(url + ".i420")` with an `AbortController`.
- It reads one whole frame, uploads it, waits for `requestAnimationFrame`, then reads the next.
  - Reading stops when the window is hidden, so TCP pushes back and the hub drops frames, as it does today.
  - Unmounting aborts the fetch, so the server unsubscribes.
- Drawing uses WebGL2 with three `R8` textures (`UNPACK_ALIGNMENT` 1). The shader converts BT.601 limited range to RGB, matching today's JPEG colours.
- The canvas's pixel size is the frame size. CSS `object-contain` / `object-cover` and the paused `brightness` filter work on a canvas as they do on an `<img>`.
- Props stand in for the `<img>` callbacks: `onFirstFrame` (replaces `onLoad`), `onFrameSize(w, h)` (replaces PiP's `naturalWidth` aspect read) and `onStreamError` (replaces `onError`).
- Pure helpers (header parsing, the context budget) go in `lib/videoFrames.ts`, so the component file exports only the component.

**Fallback to `<img src=".mjpg">`.** The surface uses it when:
- a WebGL2 context can't be created;
- the context is lost and not restored;
- the page already has 12 live contexts. Chromium drops the oldest context after 16, so a module counter in `lib/videoFrames.ts` caps them.

## Steps

0. (Done: this file.)
1. **Rust.** Make the hub, route and worker changes in `src-tauri/src/video/stream.rs`. Unit tests:
   - frame header and plane packing;
   - format routing;
   - a slow raw consumer still never queues (extend `disconnected_or_slow_consumers_never_create_an_unbounded_queue`);
   - an odd-sized source gives even dimensions.
2. **Page.** Add `lib/videoFrames.ts` (with `lib/videoFrames.test.ts`) and `components/media/VideoSurface.tsx`.
   - Use it in `components/media/MediaTile.tsx` (the `<img>` near line 167).
   - Use it in `components/media/PictureInPictureWindow.tsx` (the `<img>` near line 144, and `readAspect`).
   - `streamUrl` from `videoStreamUrl` in `useNativeMediaTiles.ts` stays the base. The surface adds the suffix.
3. **Gate.** Before polishing, measure again with the rig and the scratchpad scripts from 2026-11-13 (`measure.ps1`, `prof.ts`), release build plus production frontend:
   - 4×720p30 against the baseline (Rust 73%, WebView 35%);
   - one 1080p30 share.

   Continue only if total CPU drops by about 40% or more and the GPU process memory falls. Otherwise stop and report.
4. **Fallback.** Check the fallback by forcing it (a temporary flag that makes context creation fail). Both tiles and PiP must still show video.
5. **Docs.** Update `.claude/skills/raven-media-engine/references/video-engine.md`: the receive path, picture in picture ("frames are MJPEG in an `<img>`") and the stats meaning.

## Files

- `apps/desktop/src-tauri/src/video/stream.rs`: hub formats, `.i420` route, CORS, worker.
- `apps/desktop/src/lib/videoFrames.ts` and `.test.ts`: new.
- `apps/desktop/src/components/media/VideoSurface.tsx`: new.
- `apps/desktop/src/components/media/MediaTile.tsx` and `PictureInPictureWindow.tsx`: swap `<img>` for `VideoSurface`.
- No Tauri command, `lib/video.ts` contract or CSP change. `connect-src` already allows `http:`.

## Verification

- `cargo.ps1 test --release --lib stream` and `bun test` in `apps/desktop`. Then `bun run build` and `sweep.ts`.
- Live check with the rig on the release build and production frontend, using `share-bot.py` ×4 and 1 camera:
  - tiles at 980×700 and fullscreen;
  - PiP open and resized (aspect follows);
  - Stop watching / Watch again;
  - your own camera preview (local preview mode);
  - minimise Raven, then check that `shownFps` falls and Rust CPU drops (backpressure);
  - colours compared with a screenshot of the JPEG path.
- Compare numbers with the baseline table in Context.
- Not verifiable here: Linux (WebKitGTK `fetch` streaming from `tauri://` to `http://127.0.0.1`, WebGL2 availability), and machines without a GPU. Report these as unverified.
