// Turns the text of a message into a small tree the interface draws.
//
// The text is never treated as HTML. Formatting is a handful of marks people already
// type (**bold**, *italic*, ~~struck~~, `code`, fenced code), and the only thing that
// becomes clickable is a web address written out in full. There is deliberately no
// "[label](address)" form: a link whose words differ from where it goes is how people
// are tricked.

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; text: string }
  /** A person (`<@u:id>`), voice nest (`<@n:id>`) or text nest (`<@t:id>`). Drawing decides whether the id is known. */
  | { type: "mention"; target: "user" | "nest" | "text"; id: string };

export type Block =
  /** One line of the message. Each is given its own direction when drawn. */
  | { type: "paragraph"; children: Inline[] }
  /** A fenced block. `language` is the name after the opening fence ("```go"), lowercased. */
  | { type: "code"; text: string; language?: string };

/** A language name as people write it after a fence: "ts", "c++", "objective-c", "c#". */
const FENCE_LANGUAGE = /^[a-z0-9_+#.-]{1,32}$/;

/**
 * Characters that change the direction text is drawn in. Inside a message they are
 * harmless, because every paragraph is isolated. Inside a web address they can make it
 * read as a different address, so they are removed there.
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const ADDRESS = /^https?:\/\/[^\s<>]+/i;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", "\"", "»", "”", "’", "،", "؛", "؟", "…"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const MAX_NESTING = 4;
const MENTION = /^<@([unt]):([^\s<>]{1,64})>/;
const MENTION_TARGETS = { u: "user", n: "nest", t: "text" } as const;

const PAIRS: Array<{ marker: string; type: "bold" | "italic" | "strike"; wordBound: boolean }> = [
  { marker: "**", type: "bold", wordBound: false },
  { marker: "~~", type: "strike", wordBound: false },
  { marker: "*", type: "italic", wordBound: true },
  { marker: "_", type: "italic", wordBound: true },
];

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}

function isSpace(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/**
 * Splits a written-out address from punctuation that merely follows it in the sentence,
 * and checks it is a real http or https address. Returns how many characters of the
 * original text the address takes up.
 */
function readAddress(raw: string): { href: string; text: string; length: number } | null {
  let end = raw.length;
  while (end > 0) {
    const last = raw[end - 1];
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      // A closing bracket belongs to the address only if it closes one inside it.
      const body = raw.slice(0, end - 1);
      if (body.split(opener).length <= body.split(last).length) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  const cleaned = raw.slice(0, end).replace(BIDI_CONTROLS, "");
  try {
    const parsed = new URL(cleaned);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
    return { href: parsed.href, text: cleaned, length: end };
  } catch {
    return null;
  }
}

/** Finds where a mark that opens at `start` closes, or -1 if it never properly does. */
function findClosing(text: string, start: number, marker: string, wordBound: boolean): number {
  const contentStart = start + marker.length;
  if (isSpace(text[contentStart])) return -1;
  if (wordBound && isWordCharacter(text[start - 1])) return -1;
  let from = contentStart + 1;
  while (from <= text.length - marker.length) {
    const at = text.indexOf(marker, from);
    if (at < 0) return -1;
    const before = text[at - 1];
    const after = text[at + marker.length];
    const single = marker.length === 1;
    // A single mark must not be half of a double one, and must end against a word.
    const partOfDouble = single && (before === marker || after === marker);
    if (!isSpace(before) && !partOfDouble && !(wordBound && isWordCharacter(after))) return at;
    from = at + 1;
  }
  return -1;
}

function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ type: "text", text: plain });
    plain = "";
  };

  let index = 0;
  scan: while (index < text.length) {
    const character = text[index];

    if (character === "`") {
      const end = text.indexOf("`", index + 1);
      if (end > index + 1) {
        flush();
        out.push({ type: "code", text: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (character === "<") {
      const match = MENTION.exec(text.slice(index, index + 72));
      if (match) {
        flush();
        out.push({ type: "mention", target: MENTION_TARGETS[match[1] as keyof typeof MENTION_TARGETS], id: match[2] });
        index += match[0].length;
        continue;
      }
    }

    if ((character === "h" || character === "H") && !isWordCharacter(text[index - 1])) {
      const match = ADDRESS.exec(text.slice(index));
      const address = match && readAddress(match[0]);
      if (address) {
        flush();
        out.push({ type: "link", href: address.href, text: address.text });
        index += address.length;
        continue;
      }
    }

    if (depth < MAX_NESTING) {
      for (const pair of PAIRS) {
        if (!text.startsWith(pair.marker, index)) continue;
        // "**" is tried before "*", so a lone "*" here is never the start of a "**".
        const close = findClosing(text, index, pair.marker, pair.wordBound);
        if (close < 0) continue;
        flush();
        out.push({ type: pair.type, children: parseInline(text.slice(index + pair.marker.length, close), depth + 1) });
        index = close + pair.marker.length;
        continue scan;
      }
    }

    plain += character;
    index += 1;
  }
  flush();
  return out;
}

/** Parses a message into blocks: lines of text, and fenced blocks of code. */
export function parseMessage(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trimStart().startsWith("```")) {
      const close = lines.findIndex((candidate, at) => at > index && candidate.trim() === "```");
      if (close > index) {
        // Anything after the opening fence on its line is a language name, not code. Only
        // its first word counts ("```ts title" names ts); anything else is ignored.
        const language = line.trimStart().slice(3).trim().split(/\s+/)[0].toLowerCase();
        const text = lines.slice(index + 1, close).join("\n");
        blocks.push(FENCE_LANGUAGE.test(language) ? { type: "code", text, language } : { type: "code", text });
        index = close + 1;
        continue;
      }
    }
    blocks.push({ type: "paragraph", children: parseInline(line) });
    index += 1;
  }
  return blocks;
}

// Described here because the project's TypeScript library settings predate Intl.Segmenter.
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: "grapheme" }) => GraphemeSegmenter }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;

/** What a person would count as characters: an emoji family or a flag is one. */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const NOT_EMOJI = /[\p{L}\p{N}]/u;

/**
 * How many emoji a message consists of, when it is nothing but one to three of them.
 * Such messages are drawn larger. Anything else returns 0.
 */
export function emojiOnlyCount(body: string): number {
  const parts = graphemes(body.trim()).filter((part) => part.trim() !== "");
  if (parts.length === 0 || parts.length > 3) return 0;
  return parts.every((part) => EMOJI.test(part) && !NOT_EMOJI.test(part)) ? parts.length : 0;
}
