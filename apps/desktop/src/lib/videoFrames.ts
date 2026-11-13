// Helpers for the raw I420 video path (`.i420` frames from the native frame server,
// drawn by `components/media/VideoSurface.tsx`). Wire format: a 16-byte little-endian
// header (`RVF1`, width u32, height u32, payload length u32), then tight Y, U and V planes.

export const RAW_HEADER_BYTES = 16;

/** Chromium drops the oldest WebGL context past 16 on a page; stay well under it. */
export const MAX_VIDEO_CONTEXTS = 12;

export type RawFrameHeader = { width: number; height: number; payload: number };

export function rawStreamUrl(mjpegUrl: string): string {
  return mjpegUrl.replace(/\.mjpg(?=$|[?#])/, ".i420");
}

/** Parse a frame header; null when it is malformed (wrong magic, odd or empty size, bad length). */
export function parseFrameHeader(bytes: Uint8Array): RawFrameHeader | null {
  if (bytes.length < RAW_HEADER_BYTES) return null;
  if (bytes[0] !== 0x52 || bytes[1] !== 0x56 || bytes[2] !== 0x46 || bytes[3] !== 0x31) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, RAW_HEADER_BYTES);
  const width = view.getUint32(4, true);
  const height = view.getUint32(8, true);
  const payload = view.getUint32(12, true);
  if (width === 0 || height === 0 || width % 2 !== 0 || height % 2 !== 0) return null;
  if (payload !== (width * height * 3) / 2) return null;
  return { width, height, payload };
}

let liveContexts = 0;

/** Reserve a WebGL context slot; false when the page is at its budget (use the JPEG stream). */
export function acquireVideoContext(): boolean {
  if (liveContexts >= MAX_VIDEO_CONTEXTS) return false;
  liveContexts += 1;
  return true;
}

export function releaseVideoContext(): void {
  liveContexts = Math.max(0, liveContexts - 1);
}

export function liveVideoContexts(): number {
  return liveContexts;
}

type ChunkReader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };

/** Reads exact byte counts out of a fetch body, whatever the chunking. */
export class ExactReader {
  private chunk: Uint8Array | null = null;
  private offset = 0;

  constructor(private readonly source: ChunkReader) {}

  /** Fill `target` completely; throws when the stream ends first. */
  async readInto(target: Uint8Array): Promise<void> {
    let filled = 0;
    while (filled < target.length) {
      if (!this.chunk || this.offset >= this.chunk.length) {
        const { done, value } = await this.source.read();
        if (done || !value) throw new Error("video stream ended");
        this.chunk = value;
        this.offset = 0;
        continue;
      }
      const take = Math.min(target.length - filled, this.chunk.length - this.offset);
      target.set(this.chunk.subarray(this.offset, this.offset + take), filled);
      this.offset += take;
      filled += take;
    }
  }
}
