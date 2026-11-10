import { useState, type CSSProperties, type ReactNode } from "react";
import { FileQuestion, ImageOff, RotateCw } from "lucide-react";
import { gridRows, IMAGE_MAX_WIDTH, imageBox, planAttachments, UNKNOWN_RENDERER } from "@/lib/chat/attachments";
import { listVariant } from "@/lib/chat/imageActions";
import { getAttachmentUrl, getLocalUrl, localKey, mediaCache, serverKey } from "@/lib/chat/media";
import type { ChatAttachment, PendingAttachment } from "@/lib/chat/types";
import { cn } from "@/lib/utils";
import { placeholderUrl, useCachedUrl, useNearViewport } from "./attachmentHooks";
import { LibraryMedia, type LibraryMediaSource } from "@/components/library/LibraryMedia";
import { libraryBox } from "@/lib/library/types";

/** One image as the list draws it, wherever its bytes come from. */
interface ImageEntry {
  key: string;
  width?: number;
  height?: number;
  placeholder?: string;
  load: () => Promise<string>;
}

/** One image cell. The space is reserved before anything loads, so the list never jumps. */
function ImageCell({ image, alt, style, className, onOpen }: { image: ImageEntry; alt: string; style?: CSSProperties; className?: string; onOpen?: () => void }) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  // Fade in only what had to be fetched; an image already here simply appears.
  const [wasCached] = useState(() => Boolean(mediaCache.peek(image.key)));
  const { url, failed, gone, retry } = useCachedUrl(image.key, image.load, near);
  const [loaded, setLoaded] = useState(false);
  const blur = placeholderUrl(image.placeholder);
  return (
    <div ref={ref} style={style} className={cn("relative overflow-hidden bg-secondary", className)}>
      {blur && !loaded ? <img src={blur} alt="" aria-hidden className="absolute inset-0 h-full w-full object-cover" /> : null}
      {url && !gone ? (
        <img
          src={url}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={() => setLoaded(true)}
          className={cn("absolute inset-0 h-full w-full object-cover", !wasCached && "animate-fade-in")}
        />
      ) : null}
      {gone ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-secondary p-3 text-center text-caption text-muted-foreground">
          <ImageOff className="h-4 w-4 shrink-0" aria-hidden />
          This image is no longer available.
        </div>
      ) : failed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-secondary/80">
          <button type="button" onClick={retry} className="flex h-8 items-center gap-1.5 rounded-control bg-popover px-2.5 text-caption font-medium text-foreground transition-colors hover:bg-accent">
            <RotateCw className="h-3.5 w-3.5" aria-hidden />
            Couldn’t load. Try again
          </button>
        </div>
      ) : onOpen ? (
        <button type="button" aria-label={`Open ${alt.charAt(0).toLowerCase()}${alt.slice(1)}`} onClick={onOpen} className="absolute inset-0 cursor-zoom-in focus-visible:-outline-offset-2" />
      ) : null}
    </div>
  );
}

const GRID_GAP = 2;

/**
 * Images in the message list. One is fitted in its box keeping its shape; several make a
 * grid of two columns with cells cropped to fill. `footer` sits over the last image (the
 * time, when there is no caption to carry it).
 */
function ImageGroup({ images, altFor, onOpen, footer }: { images: ImageEntry[]; altFor: (index: number) => string; onOpen?: (index: number) => void; footer?: ReactNode }) {
  if (images.length === 1) {
    const [image] = images;
    const box = imageBox(image.width, image.height);
    return (
      <div className="relative" style={{ width: box.width, maxWidth: "100%" }}>
        <ImageCell image={image} alt={altFor(0)} onOpen={onOpen ? () => onOpen(0) : undefined} className="rounded-control" style={{ aspectRatio: `${box.width} / ${box.height}` }} />
        {footer}
      </div>
    );
  }
  let index = -1;
  return (
    <div className="relative flex flex-col overflow-hidden rounded-control" style={{ width: IMAGE_MAX_WIDTH, maxWidth: "100%", gap: GRID_GAP }}>
      {gridRows(images).map((row, rowIndex) => (
        <div key={rowIndex} className="flex" style={{ gap: GRID_GAP }}>
          {row.map((image) => {
            index += 1;
            const at = index;
            return (
              <ImageCell
                key={image.key}
                image={image}
                alt={altFor(at)}
                onOpen={onOpen ? () => onOpen(at) : undefined}
                className="min-w-0 flex-1"
                style={{ aspectRatio: row.length === 1 ? "2 / 1" : "1 / 1" }}
              />
            );
          })}
        </div>
      ))}
      {footer}
    </div>
  );
}

function altText(sender: string, index: number, total: number) {
  return total > 1 ? `Image from ${sender}, ${index + 1} of ${total}` : `Image from ${sender}`;
}

interface RendererProps {
  conversationId: string;
  attachments: ChatAttachment[];
  senderName: string;
  /** Opens the viewer at an image of this run. */
  onOpen?: (attachment: ChatAttachment) => void;
  footer?: ReactNode;
}

function ImageAttachments({ conversationId, attachments, senderName, onOpen, footer }: RendererProps) {
  const images = attachments.map((attachment): ImageEntry => {
    const variant = listVariant(attachment);
    return {
      key: serverKey(attachment.id, variant),
      width: attachment.width,
      height: attachment.height,
      placeholder: attachment.placeholder,
      load: () => getAttachmentUrl(conversationId, attachment.id, variant),
    };
  });
  return (
    <ImageGroup
      images={images}
      altFor={(index) => altText(senderName, index, images.length)}
      onOpen={onOpen ? (index) => onOpen(attachments[index]) : undefined}
      footer={footer}
    />
  );
}

/** What this version can't show. A newer Raven sends kinds it doesn't know yet. */
export function UnknownAttachments() {
  return (
    <p className="flex items-center gap-2 py-0.5 text-small text-muted-foreground">
      <FileQuestion className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      Sent from a newer version of Raven. Update to see it.
    </p>
  );
}

/**
 * A GIF or sticker sent from a library: one per message, with no bubble. A click pauses
 * it. An attachment missing its asset is drawn as unknown.
 */
function LibraryAttachments({ attachments, footer }: RendererProps) {
  return (
    <>
      {attachments.map((attachment, index) => {
        const source = libraryMediaOf(attachment);
        if (!source) return <UnknownAttachments key={attachment.id} />;
        const box = libraryBox(source.kind, attachment.width, attachment.height);
        return (
          <div key={attachment.id} className="relative max-w-full" style={{ width: box.width }}>
            <LibraryMedia media={source} width={box.width} height={box.height} holdOnClick />
            {index === attachments.length - 1 ? footer : null}
          </div>
        );
      })}
    </>
  );
}

/** What LibraryMedia needs from a message's GIF or sticker; null when it is incomplete. */
export function libraryMediaOf(attachment: ChatAttachment): LibraryMediaSource | null {
  if (!attachment.assetId || !attachment.format || (attachment.kind !== "gif" && attachment.kind !== "sticker")) return null;
  return { assetId: attachment.assetId, kind: attachment.kind, format: attachment.format, variants: attachment.variants, title: attachment.name };
}

/** The renderer for each kind this version can draw. A new kind is a new entry here. */
const attachmentRenderers: Record<string, (props: RendererProps) => ReactNode> = { image: ImageAttachments, gif: LibraryAttachments, sticker: LibraryAttachments };
const RENDERED_KINDS: ReadonlySet<string> = new Set(Object.keys(attachmentRenderers));

/** A message's attachments, each run of one kind drawn by that kind's renderer. */
export function MessageAttachments({ conversationId, attachments, senderName, onOpen, footer }: RendererProps) {
  const runs = planAttachments(attachments, RENDERED_KINDS);
  return (
    <div className="flex flex-col gap-1">
      {runs.map((run, index) => {
        const last = index === runs.length - 1;
        if (run.renderer === UNKNOWN_RENDERER) return <UnknownAttachments key={index} />;
        const Renderer = attachmentRenderers[run.renderer];
        return <Renderer key={index} conversationId={conversationId} attachments={run.attachments} senderName={senderName} onOpen={onOpen} footer={last ? footer : undefined} />;
      })}
    </div>
  );
}

/** The images of a message still being sent, from the copies on this computer, at the same sizes. */
export function PendingAttachments({ attachments, footer }: { attachments: PendingAttachment[]; footer?: ReactNode }) {
  const images = attachments.map(({ handle, description }): ImageEntry => {
    const variant = description.variants.some((candidate) => candidate.variant === "preview") ? "preview" : "full";
    const contentType = description.variants.find((candidate) => candidate.variant === variant)?.contentType ?? description.contentType;
    return {
      key: localKey(handle, variant),
      width: description.width,
      height: description.height,
      placeholder: description.placeholder,
      load: () => getLocalUrl(handle, variant, contentType),
    };
  });
  return <ImageGroup images={images} altFor={(index) => altText("you", index, images.length)} footer={footer} />;
}

