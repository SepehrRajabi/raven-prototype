import { describe, expect, test } from "bun:test";
import { pinActions, pinExcerpt, pinLimits, pinLine, pinTooltip } from "./pins";
import { systemLine } from "./text";
import type { ChatMessage } from "./types";

const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "x", kind: "text", body: "Hello  there", createdAt: "2026-11-01T10:00:00Z",
};
const pin = { byId: "ava", byName: "Ava", at: "2026-11-02T10:00:00Z" };

describe("who may pin", () => {
  const member = { canPin: false, canManage: false, canWrite: true, me: "kian" };
  const runsIt = { canPin: true, canManage: true, canWrite: true, me: "mina" };
  test("someone who manages the room pins and unpins any text message", () => {
    expect(pinActions(message, runsIt)).toEqual({ pin: true, unpin: false });
    expect(pinActions({ ...message, pin }, runsIt)).toEqual({ pin: false, unpin: true });
  });
  test("an author can only unpin their own message", () => {
    expect(pinActions(message, { ...member, me: "sara" })).toEqual({ pin: false, unpin: false });
    expect(pinActions({ ...message, pin }, { ...member, me: "sara" })).toEqual({ pin: false, unpin: true });
    expect(pinActions({ ...message, pin }, { ...member, me: "sara", canWrite: false })).toEqual({ pin: false, unpin: true });
  });
  test("when the room lets members pin, a member pins and takes off only the pins they made", () => {
    const allowed = { ...member, canPin: true };
    expect(pinActions(message, allowed)).toEqual({ pin: true, unpin: false });
    expect(pinActions({ ...message, pin }, allowed)).toEqual({ pin: false, unpin: false });
    expect(pinActions({ ...message, pin: { ...pin, byId: "kian" } }, allowed)).toEqual({ pin: false, unpin: true });
  });
  test("whoever made a pin can take it off while they can write, even once members can no longer pin", () => {
    const made = { ...message, pin: { ...pin, byId: "kian" } };
    expect(pinActions(made, member)).toEqual({ pin: false, unpin: true });
    expect(pinActions(made, { ...member, canWrite: false })).toEqual({ pin: false, unpin: false });
  });
  test("everyone else gets neither", () => {
    expect(pinActions({ ...message, pin }, member)).toEqual({ pin: false, unpin: false });
  });
  test("deleted messages and system lines get neither", () => {
    expect(pinActions({ ...message, deletedAt: "2026-11-03T10:00:00Z" }, { ...runsIt, me: "sara" })).toEqual({ pin: false, unpin: false });
    expect(pinActions({ ...message, kind: "system" }, { ...runsIt, me: "sara" })).toEqual({ pin: false, unpin: false });
  });
});

describe("what the server allows", () => {
  test("pins are on only when the server says how many a room may have", () => {
    expect(pinLimits({ chat: { pins: { max: 50 } } })).toEqual({ max: 50 });
    expect(pinLimits({ chat: {} })).toBeNull();
    expect(pinLimits({ chat: { pins: { max: 0 } } })).toBeNull();
    expect(pinLimits(undefined)).toBeNull();
  });
});

describe("how a pin is described", () => {
  test("by name, or as you", () => {
    expect(pinTooltip(pin, "me")).toStartWith("Pinned by Ava · ");
    expect(pinTooltip({ ...pin, byId: "me" }, "me")).toStartWith("Pinned by you · ");
    expect(pinLine(pin, "me", Date.parse("2026-11-20T10:00:00Z"))).toMatch(/^Pinned by Ava · \S/);
    expect(pinLine({ ...pin, at: "" }, "me")).toBe("Pinned by Ava");
  });
  test("the excerpt is the text on one line, or what the message holds", () => {
    expect(pinExcerpt(message)).toBe("Hello there");
    expect(pinExcerpt({ ...message, body: "", attachments: [{ id: "a", kind: "image", source: "stored", contentType: "image/jpeg", size: 1, variants: [] }] })).toBe("Photo");
  });
});

describe("the line a room shows when the setting changes", () => {
  test("says who let members pin, or stopped them", () => {
    expect(systemLine({ event: "pinning_changed", membersCanPin: true }, "mina", "Mina", "me")).toBe("Mina let members pin messages");
    expect(systemLine({ event: "pinning_changed", membersCanPin: false }, "me", "Me", "me")).toStartWith("You stopped members pinning messages");
  });
});
