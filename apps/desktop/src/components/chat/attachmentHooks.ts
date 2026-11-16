// Hooks for drawing attachments: where their bytes are, whether they are close enough to
// the screen to be worth loading, and the blurred stand-in shown until they arrive.

import { useCallback, useEffect, useRef, useState } from "react";
import { thumbHashToDataURL } from "thumbhash";
import { mediaCache } from "@/lib/chat/media";
import { AttachmentGoneError } from "@/lib/chat/mediaCache";

/**
 * True once the element comes within about a screen of the viewport, and from then on.
 * Images further away are not fetched until the person scrolls towards them.
 */
export function useNearViewport<T extends Element>(): [(element: T | null) => void, boolean] {
  const [near, setNear] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (element: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!element || near) return;
      if (typeof IntersectionObserver === "undefined") {
        setNear(true);
        return;
      }
      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setNear(true);
            observer.current?.disconnect();
          }
        },
        { rootMargin: "100% 0px" },
      );
      observer.current.observe(element);
    },
    [near],
  );
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, near];
}

export interface CachedUrl {
  url: string | undefined;
  /** Loading failed in a way worth another try. */
  failed: boolean;
  /** It will never load: deleted, or no longer visible to this person. */
  gone: boolean;
  retry: () => void;
}

/**
 * An object URL from the media cache, loading it when `enabled`. What is already in the
 * cache is there on the first render, so a message that replaces its pending copy, or a
 * row scrolled back into view, draws its image at once.
 */
export function useCachedUrl(key: string | null, load: () => Promise<string>, enabled: boolean): CachedUrl {
  const [url, setUrl] = useState<string | undefined>(() => (key ? mediaCache.peek(key) : undefined));
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(() => (key ? mediaCache.isGone(key) : false));
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    const cached = mediaCache.peek(key);
    if (cached) {
      setUrl(cached);
      return mediaCache.hold(key);
    }
    if (!enabled || mediaCache.isGone(key)) {
      setGone(mediaCache.isGone(key));
      return;
    }
    let live = true;
    // Held from before the load starts: two loads finishing together over the budget
    // could otherwise evict and revoke this URL before it is shown.
    let release: (() => void) | null = mediaCache.hold(key);
    setFailed(false);
    loadRef.current().then(
      (next) => {
        if (!live) return;
        setUrl(next);
      },
      (error: unknown) => {
        if (!live) return;
        release?.();
        release = null;
        if (error instanceof AttachmentGoneError) setGone(true);
        else setFailed(true);
      },
    );
    return () => {
      live = false;
      release?.();
    };
  }, [key, enabled, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { url, failed, gone, retry };
}

const placeholders = new Map<string, string | null>();

/** The ThumbHash stand-in as a data URL, worked out once per placeholder. */
export function placeholderUrl(placeholder: string | undefined): string | null {
  if (!placeholder) return null;
  const known = placeholders.get(placeholder);
  if (known !== undefined) return known;
  let url: string | null = null;
  try {
    const binary = atob(placeholder);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    url = thumbHashToDataURL(bytes);
  } catch {
    url = null;
  }
  if (placeholders.size > 2000) placeholders.clear();
  placeholders.set(placeholder, url);
  return url;
}
