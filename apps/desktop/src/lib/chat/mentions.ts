// Mentions of people and nests inside a message.
//
// The stored text holds a token (`<@u:id>`, `<@n:id>`, `<@t:id>`), never a name, so a
// rename shows up in old messages too. The composer shows names while writing and turns
// them into tokens on send; editing turns tokens back into names.

import { parseMessage, type Inline } from "./format";

export type MentionTarget = "user" | "nest" | "text";

const LETTER: Record<MentionTarget, string> = { user: "u", nest: "n", text: "t" };
const TARGET: Record<string, MentionTarget> = { u: "user", n: "nest", t: "text" };

const MENTION_TOKENS = /<@([unt]):([^\s<>]{1,64})>/g;

export function mentionToken(target: MentionTarget, id: string): string {
  return `<@${LETTER[target]}:${id}>`;
}

export interface MentionPerson {
  name: string;
  username: string;
  /** Shown as the small face's dot on hover, when known. */
  presence?: import("@/shells/ravenv1/state").Presence;
}

export interface MentionNest {
  name: string;
  kind: "voice" | "text";
  /** Who is inside a voice nest now. */
  people: Array<{ id: string; name: string }>;
}

/** Looks up what a mention points at. Null means unknown, removed or out of reach. */
export interface MentionResolver {
  /** The reader's word for one nest (`data.labels.nestSingular`). */
  nestSingular: string;
  person(id: string): MentionPerson | null;
  nest(target: "nest" | "text", id: string): MentionNest | null;
}

/** Something the composer can mention. */
export interface MentionCandidate {
  target: MentionTarget;
  id: string;
  name: string;
  username?: string;
}

/** A name the composer inserted, and the token it stands for. */
export interface PickedMention {
  text: string;
  token: string;
}

type MentionNode = Extract<Inline, { type: "mention" }>;

function eachMention(nodes: Inline[], visit: (node: MentionNode) => void) {
  for (const node of nodes) {
    if (node.type === "mention") visit(node);
    else if ("children" in node) eachMention(node.children, visit);
  }
}

/** Whether a message mentions this person outside code. */
export function mentionsUser(body: string, userId: string): boolean {
  if (!userId || !body.includes("<@u:")) return false;
  let found = false;
  for (const block of parseMessage(body)) {
    if (block.type === "paragraph") eachMention(block.children, (node) => {
      if (node.target === "user" && node.id === userId) found = true;
    });
  }
  return found;
}

/** How a mention reads as plain text, for notifications and previews. */
export function mentionPlainText(node: MentionNode, resolve: MentionResolver | undefined): string {
  if (node.target === "user") return resolve?.person(node.id)?.name ?? "someone";
  const nest = resolve?.nest(node.target, node.id);
  if (nest) return nest.name;
  return resolve ? `a ${resolve.nestSingular.toLowerCase()}` : "…";
}

// An excerpt is cut by length, which can fall inside a token.
const CUT_TOKEN = /<@(?:[unt](?::[^\s<>…]*)?)?…$/;

/** An excerpt of a message with each mention as its name, for quotes. Code stays as written. */
export function mentionsAsText(excerpt: string, resolve: MentionResolver | undefined): string {
  if (!excerpt.includes("<@")) return excerpt;
  return outsideCode(excerpt, (part) => part.replace(MENTION_TOKENS, (_, letter: string, id: string) =>
    mentionPlainText({ type: "mention", target: TARGET[letter], id }, resolve))).replace(CUT_TOKEN, "…");
}

/** What a mention of something gone says: "a removed nest". */
export function removedNestText(resolve: MentionResolver): string {
  return `a removed ${resolve.nestSingular.toLowerCase()}`;
}

// Code spans and fenced blocks are left exactly as written.
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

function outsideCode(text: string, change: (part: string) => string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(CODE)) {
    out += change(text.slice(last, match.index)) + match[0];
    last = (match.index ?? 0) + match[0].length;
  }
  return out + change(text.slice(last));
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A mention ends where a word does: "@Sara," is Sara, "@Sarah" is not.
const ENDS = "(?![\\p{L}\\p{N}_])";

/**
 * Turns what the composer shows into what is sent: each picked name still present
 * becomes its token, then an exact `@username` of a member does too.
 */
export function toTokens(text: string, picked: PickedMention[], members: Array<{ id: string; username: string }>): string {
  const byLength = [...picked].sort((a, b) => b.text.length - a.text.length);
  const usernames = new Map(members.map((member) => [member.username.toLowerCase(), member.id]));
  return outsideCode(text, (part) => {
    let result = part;
    for (const pick of byLength) {
      result = result.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(pick.text)}${ENDS}`, "gu"), (_, before: string) => before + pick.token);
    }
    return result.replace(/(^|[^\p{L}\p{N}_<])@([\p{L}\p{N}_.-]*[\p{L}\p{N}_])/gu, (whole, before: string, name: string) => {
      const id = usernames.get(name.toLowerCase());
      return id ? before + mentionToken("user", id) : whole;
    });
  });
}

/** Turns a stored message back into names for editing, remembering which is which. */
export function fromTokens(body: string, resolve: MentionResolver): { text: string; picked: PickedMention[] } {
  const picked: PickedMention[] = [];
  const text = outsideCode(body, (part) => part.replace(MENTION_TOKENS, (token, letter: string, id: string) => {
    const target = TARGET[letter];
    const name = target === "user" ? resolve.person(id)?.name : resolve.nest(target, id)?.name;
    if (!name) return token;
    const shown = `@${name}`;
    if (!picked.some((pick) => pick.text === shown && pick.token === token)) picked.push({ text: shown, token });
    return shown;
  }));
  return { text, picked };
}

/** The `@word` being typed at the caret, when it starts a word. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,32})$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Candidates whose name or username starts a word with the query; names first. */
export function filterCandidates(candidates: MentionCandidate[], query: string, limit = 8): MentionCandidate[] {
  const wanted = fold(query);
  const score = (candidate: MentionCandidate) => {
    const name = fold(candidate.name);
    const username = fold(candidate.username ?? "");
    if (name.startsWith(wanted) || username.startsWith(wanted)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(wanted))) return 1;
    return name.includes(wanted) || username.includes(wanted) ? 2 : -1;
  };
  return candidates
    .map((candidate) => ({ candidate, rank: score(candidate) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
