import { describe, expect, test } from "bun:test";
import {
  acquireVideoContext,
  ExactReader,
  liveVideoContexts,
  MAX_VIDEO_CONTEXTS,
  parseFrameHeader,
  rawStreamUrl,
  releaseVideoContext,
} from "./videoFrames";

function header(width: number, height: number, payload = (width * height * 3) / 2) {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x56, 0x46, 0x31]);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, payload, true);
  return bytes;
}

describe("raw video frames", () => {
  test("parses a valid header", () => {
    expect(parseFrameHeader(header(1280, 720))).toEqual({ width: 1280, height: 720, payload: 1382400 });
  });

  test("accepts odd sizes with chroma rounded up", () => {
    // 427x241: chroma planes are 214x121.
    expect(parseFrameHeader(header(427, 241, 427 * 241 + 2 * 214 * 121))).toEqual({
      width: 427,
      height: 241,
      payload: 427 * 241 + 2 * 214 * 121,
    });
  });

  test("rejects bad magic and wrong lengths", () => {
    const badMagic = header(4, 2);
    badMagic[0] = 0;
    expect(parseFrameHeader(badMagic)).toBeNull();
    expect(parseFrameHeader(header(5, 2, 15))).toBeNull();
    expect(parseFrameHeader(header(4, 2, 11))).toBeNull();
    expect(parseFrameHeader(header(0, 0, 0))).toBeNull();
    expect(parseFrameHeader(new Uint8Array(8))).toBeNull();
  });

  test("swaps only the stream suffix", () => {
    expect(rawStreamUrl("http://127.0.0.1:1/tok/abc-1.mjpg")).toBe("http://127.0.0.1:1/tok/abc-1.i420");
  });

  test("context budget is capped and released", () => {
    const start = liveVideoContexts();
    let taken = 0;
    while (acquireVideoContext()) taken += 1;
    expect(liveVideoContexts()).toBe(MAX_VIDEO_CONTEXTS);
    expect(taken).toBe(MAX_VIDEO_CONTEXTS - start);
    for (let i = 0; i < taken; i += 1) releaseVideoContext();
    expect(liveVideoContexts()).toBe(start);
  });

  test("reads exact lengths across chunk boundaries", async () => {
    const chunks = [Uint8Array.of(1, 2, 3), Uint8Array.of(4), Uint8Array.of(5, 6, 7, 8)];
    const reader = new ExactReader({
      read: async () => {
        const value = chunks.shift();
        return value ? { done: false, value } : { done: true };
      },
    });
    const first = new Uint8Array(5);
    await reader.readInto(first);
    expect([...first]).toEqual([1, 2, 3, 4, 5]);
    const second = new Uint8Array(3);
    await reader.readInto(second);
    expect([...second]).toEqual([6, 7, 8]);
    await expect(reader.readInto(new Uint8Array(1))).rejects.toThrow();
  });
});
