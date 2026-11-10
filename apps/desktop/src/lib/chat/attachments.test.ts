import { describe, expect, test } from "bun:test";
import {
  attachmentLimits,
  attachmentsExcerpt,
  canSendImages,
  gridRows,
  imageBox,
  messageExcerpt,
  onlyPictures,
  planAttachments,
  saveName,
  UNKNOWN_RENDERER,
} from "./attachments";
import { previewLine } from "./text";
import type { ChatConversation } from "./types";

const announced = {
  chat: {
    attachments: {
      version: 1,
      kinds: { image: { variants: { full: 10_485_760, preview: 524_288 }, maxPixels: 100_000_000, maxSide: 16384 } },
      sources: ["stored"],
      maxPerMessage: 10,
    },
  },
};

describe("what the server takes", () => {
  test("is read from its properties", () => {
    const limits = attachmentLimits(announced);
    expect(limits).toEqual({
      kinds: { image: { variants: { full: 10_485_760, preview: 524_288 }, maxPixels: 100_000_000, maxSide: 16384 } },
      sources: ["stored"],
      maxPerMessage: 10,
    });
    expect(canSendImages(limits)).toBe(true);
  });

  test("missing or malformed means nothing can be attached", () => {
    expect(attachmentLimits(undefined)).toBeNull();
    expect(attachmentLimits({ chat: { version: 1 } })).toBeNull();
    expect(attachmentLimits({ chat: { attachments: { kinds: [], sources: ["stored"], maxPerMessage: 10 } } })).toBeNull();
    expect(attachmentLimits({ chat: { attachments: { kinds: { image: { variants: {} } }, sources: [], maxPerMessage: 10 } } })).toBeNull();
    expect(attachmentLimits({ chat: { attachments: { kinds: { image: { variants: {} } }, sources: ["stored"], maxPerMessage: "10" } } })).toBeNull();
  });

  test("a server that takes only other kinds or sources takes no images", () => {
    expect(canSendImages(attachmentLimits({ chat: { attachments: { kinds: { file: { variants: { full: 1 } } }, sources: ["stored"], maxPerMessage: 1 } } }))).toBe(false);
    expect(canSendImages(attachmentLimits({ chat: { attachments: { kinds: { image: { variants: { full: 1 } } }, sources: ["peer"], maxPerMessage: 1 } } }))).toBe(false);
    expect(canSendImages(null)).toBe(false);
  });
});

describe("the line that stands for a message", () => {
  test("says what it holds when there is no caption", () => {
    expect(attachmentsExcerpt([{ kind: "image" }])).toBe("Photo");
    expect(attachmentsExcerpt([{ kind: "image" }, { kind: "image" }])).toBe("2 photos");
    expect(attachmentsExcerpt([{ kind: "sticker" }])).toBe("Sticker");
    expect(attachmentsExcerpt([{ kind: "gif" }])).toBe("GIF");
    expect(attachmentsExcerpt([{ kind: "file" }])).toBe("Attachment");
    expect(attachmentsExcerpt([{ kind: "image" }, { kind: "video" }])).toBe("2 attachments");
    expect(attachmentsExcerpt(undefined)).toBe("");
  });

  test("the caption wins", () => {
    expect(messageExcerpt("Look at this", [{ kind: "image" }])).toBe("Look at this");
    expect(messageExcerpt("", [{ kind: "image" }])).toBe("Photo");
    expect(messageExcerpt(undefined, [{ kind: "image" }, { kind: "image" }])).toBe("2 photos");
  });

  test("a conversation's preview is never blank for an image", () => {
    const conversation = {
      kind: "dm",
      lastMessage: { id: "m1", seq: 1, senderId: "ava", senderName: "Ava", kind: "text", excerpt: "", attachments: [{ kind: "image" }], createdAt: "2026-10-30T10:00:00Z" },
    } as unknown as ChatConversation;
    expect(previewLine(conversation, "me")).toBe("Photo");
    expect(previewLine({ ...conversation, lastMessage: { ...conversation.lastMessage!, senderId: "me" } }, "me")).toBe("You: Photo");
  });
});

describe("drawing", () => {
  test("an image box keeps the shape, fits the maximum and never enlarges", () => {
    expect(imageBox(4000, 3000)).toEqual({ width: 400, height: 300 });
    expect(imageBox(1080, 1920)).toEqual({ width: 180, height: 320 });
    expect(imageBox(200, 100)).toEqual({ width: 200, height: 100 });
    expect(imageBox(8000, 100)).toEqual({ width: 400, height: 48 });
  });

  test("an image of unknown size gets a 4:3 box", () => {
    expect(imageBox(undefined, undefined)).toEqual({ width: 400, height: 300 });
    expect(imageBox(0, 10)).toEqual({ width: 400, height: 300 });
  });

  test("a grid is two to a row, an odd one out leading", () => {
    expect(gridRows([1, 2])).toEqual([[1, 2]]);
    expect(gridRows([1, 2, 3])).toEqual([[1], [2, 3]]);
    expect(gridRows([1, 2, 3, 4])).toEqual([[1, 2], [3, 4]]);
    expect(gridRows([1])).toEqual([[1]]);
  });

  test("runs of one kind go to that kind's renderer; anything unknown says to update", () => {
    const image = (id: string) => ({ id, kind: "image", source: "stored" });
    const renderers = new Set(["image"]);
    expect(planAttachments([image("a"), image("b")], renderers)).toEqual([{ renderer: "image", attachments: [image("a"), image("b")] }]);
    const sticker = { id: "s", kind: "sticker", source: "pack" };
    const peerImage = { id: "p", kind: "image", source: "peer" };
    expect(planAttachments([image("a"), sticker, peerImage, image("b")], renderers)).toEqual([
      { renderer: "image", attachments: [image("a")] },
      { renderer: UNKNOWN_RENDERER, attachments: [sticker, peerImage] },
      { renderer: "image", attachments: [image("b")] },
    ]);
    expect(onlyPictures([image("a")])).toBe(true);
    expect(onlyPictures([image("a"), sticker])).toBe(false);
    expect(onlyPictures([])).toBe(false);
  });

  test("a saved image is named for what its bytes are", () => {
    const day = new Date(2026, 9, 30);
    expect(saveName("holiday.HEIC", "image/jpeg", day)).toBe("holiday.jpg");
    expect(saveName("سفر.png", "image/webp", day)).toBe("سفر.webp");
    expect(saveName("", "image/png", day)).toBe("raven-image-2026-10-30.png");
    expect(saveName(undefined, "image/jpeg", day)).toBe("raven-image-2026-10-30.jpg");
  });
});
