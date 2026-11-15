import { describe, expect, test } from "bun:test";
import { AttachmentGoneError, MediaCache } from "./mediaCache";

function cache(budgetBytes = 100) {
  let made = 0;
  const revoked: string[] = [];
  const media = new MediaCache({ budgetBytes, createUrl: () => `blob:${(made += 1)}`, revokeUrl: (url) => void revoked.push(url) });
  return { media, revoked };
}

const bytes = (size: number) => new Blob([new Uint8Array(size)]);

describe("the media cache", () => {
  test("requests for the same variant share one fetch", async () => {
    const { media } = cache();
    let fetches = 0;
    let finish = (_blob: Blob) => {};
    const load = () => {
      fetches += 1;
      return new Promise<Blob>((resolve) => (finish = resolve));
    };
    const first = media.get("a", load);
    const second = media.get("a", load);
    finish(bytes(10));
    expect(await first).toBe(await second);
    expect(fetches).toBe(1);
    expect(await media.get("a", load)).toBe(await first);
    expect(fetches).toBe(1);
  });

  test("evicts the least recently used past the budget and revokes their URLs", async () => {
    const { media, revoked } = cache(100);
    const a = await media.get("a", async () => bytes(40));
    const b = await media.get("b", async () => bytes(40));
    media.peek("a");
    await media.get("c", async () => bytes(40));
    expect(revoked).toEqual([b]);
    expect(media.peek("b")).toBeUndefined();
    expect(media.peek("a")).toBe(a);
    expect(media.size).toBe(80);
  });

  test("keeps what is on screen, and lets it go once released", async () => {
    const { media, revoked } = cache(50);
    const a = await media.get("a", async () => bytes(40));
    const release = media.hold("a");
    await media.get("b", async () => bytes(40));
    expect(revoked).toEqual([]);
    release();
    expect(revoked).toEqual([a]);
  });

  test("seeding skips the fetch", async () => {
    const { media } = cache();
    const url = media.seed("a", bytes(10));
    let fetched = false;
    expect(await media.get("a", async () => ((fetched = true), bytes(10)))).toBe(url);
    expect(fetched).toBe(false);
  });

  test("a 404 means gone for good; anything else can be tried again", async () => {
    const { media } = cache();
    const notFound = Object.assign(new Error("not found"), { status: 404 });
    await expect(media.get("a", () => Promise.reject(notFound))).rejects.toBeInstanceOf(AttachmentGoneError);
    expect(media.isGone("a")).toBe(true);
    let tried = false;
    await expect(media.get("a", async () => ((tried = true), bytes(1)))).rejects.toBeInstanceOf(AttachmentGoneError);
    expect(tried).toBe(false);

    await expect(media.get("b", () => Promise.reject(new TypeError("offline")))).rejects.toBeInstanceOf(TypeError);
    expect(await media.get("b", async () => bytes(1))).toMatch(/^blob:/);
  });
});

describe("clearing the media cache", () => {
  test("revokes every URL and forgets what was gone", async () => {
    const { media, revoked } = cache();
    const url = await media.get("a", async () => bytes(10));
    await media.get("b", () => Promise.reject(Object.assign(new Error("gone"), { status: 404 }))).catch(() => undefined);
    expect(media.isGone("b")).toBe(true);
    media.clear();
    expect(revoked).toEqual([url]);
    expect(media.peek("a")).toBeUndefined();
    expect(media.isGone("b")).toBe(false);
    expect(media.size).toBe(0);
  });

  test("a load that started before clearing is not kept after it", async () => {
    const { media } = cache();
    let finish = (_blob: Blob) => {};
    const pending = media.get("a", () => new Promise<Blob>((resolve) => (finish = resolve)));
    media.clear();
    finish(bytes(10));
    await expect(pending).rejects.toThrow();
    expect(media.peek("a")).toBeUndefined();
  });

  test("a hold taken before the load keeps its URL when two loads finish together over the budget", async () => {
    const { media, revoked } = cache(15);
    const releaseA = media.hold("a");
    const releaseB = media.hold("b");
    const [a, b] = await Promise.all([media.get("a", async () => bytes(10)), media.get("b", async () => bytes(10))]);
    expect(revoked).not.toContain(a);
    expect(revoked).not.toContain(b);
    releaseA();
    releaseB();
  });
});
