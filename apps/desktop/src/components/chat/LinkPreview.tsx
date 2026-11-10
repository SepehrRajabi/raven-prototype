// The card under a message with a web address: what the page says about itself, as the
// server read it. Every word in it is plain text from the page, never HTML.

import { useState } from "react";
import { X } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { getLinkPreviewImageUrl, linkPreviewKey, mediaCache } from "@/lib/chat/media";
import type { ChatLinkPreview } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { useCachedUrl, useNearViewport } from "./attachmentHooks";
import { openAddress } from "./MessageText";

/** As wide as a single image in the list, so cards and pictures line up. */
const CARD_WIDTH = 400;
/** The tallest a picture across the card may be; taller ones are cropped to fit. */
const WIDE_MAX_HEIGHT = 260;

/**
 * Where the address really goes, as the reader should judge it. URL keeps an
 * internationalized name in its ASCII form, which a look-alike name cannot imitate.
 */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A picture wide enough to run across the card; anything else sits beside the text. */
export function isWidePicture(preview: ChatLinkPreview): boolean {
  const image = preview.image;
  if (!image) return false;
  if (!preview.title && !preview.description) return true;
  return image.width >= 400 && image.width / image.height >= 1.3;
}

function Picture({ conversationId, messageId, preview, wide }: { conversationId: string; messageId: string; preview: ChatLinkPreview; wide: boolean }) {
  const [ref, near] = useNearViewport<HTMLSpanElement>();
  const key = linkPreviewKey(messageId, preview.url, preview.image?.version);
  const [wasCached] = useState(() => Boolean(mediaCache.peek(key)));
  const { url, failed, gone } = useCachedUrl(key, () => getLinkPreviewImageUrl(conversationId, messageId, preview.url, preview.image?.version), near);
  const image = preview.image!;
  // A picture that won't load is left out rather than explained: the card still works.
  if (failed || gone) return null;
  return (
    <span
      ref={ref}
      className={cn("relative block shrink-0 overflow-hidden bg-foreground/[0.06]", wide ? "w-full" : "h-16 w-16 self-start rounded-chip")}
      style={wide ? { aspectRatio: `${image.width} / ${image.height}`, maxHeight: WIDE_MAX_HEIGHT } : undefined}
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          className={cn("absolute inset-0 h-full w-full object-cover", !wasCached && "animate-fade-in")}
        />
      ) : null}
    </span>
  );
}

export function LinkPreviewCard({
  conversationId,
  messageId,
  preview,
  onRemove,
}: {
  conversationId: string;
  messageId: string;
  preview: ChatLinkPreview;
  /** Set on your own messages: takes the card away for everyone. */
  onRemove?: () => void;
}) {
  const host = linkHost(preview.url);
  const wide = isWidePicture(preview);
  const hasText = Boolean(preview.title || preview.description);
  const picture = preview.image ? <Picture conversationId={conversationId} messageId={messageId} preview={preview} wide={wide} /> : null;
  return (
    <div className="group/card relative mb-0.5 mt-1.5 overflow-hidden rounded-control bg-foreground/[0.06]" style={{ width: CARD_WIDTH, maxWidth: "100%" }}>
      <a
        href={preview.url}
        title={preview.url}
        onClick={(event) => {
          event.preventDefault();
          openAddress(preview.url);
        }}
        className="block transition-colors hover:bg-foreground/[0.04] focus-visible:-outline-offset-2"
      >
        {hasText ? (
          <span className="flex gap-3 px-2.5 py-2">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={cn("truncate text-caption text-muted-foreground", onRemove && "pe-5")}>
                <bdi>{preview.siteName || host}</bdi>
                {preview.siteName && preview.siteName.toLowerCase() !== host.toLowerCase() ? <span className="text-subtle"> · {host}</span> : null}
              </span>
              {preview.title ? <span dir="auto" className="line-clamp-2 text-small font-medium text-foreground">{preview.title}</span> : null}
              {preview.description ? <span dir="auto" className="line-clamp-3 text-caption text-muted-foreground">{preview.description}</span> : null}
            </span>
            {!wide ? picture : null}
          </span>
        ) : null}
        {wide ? picture : null}
        {/* Without the page's words, the host is still shown: it is where the link goes. */}
        {!hasText ? <span className={cn("block truncate px-2.5 py-2 text-caption text-muted-foreground", onRemove && !preview.image && "pe-8")}>{host}</span> : null}
      </a>
      {onRemove ? (
        <Tooltip label="Remove preview">
          <button
            type="button"
            aria-label="Remove preview"
            onClick={onRemove}
            className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/70 text-muted-foreground opacity-0 backdrop-blur-md transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
