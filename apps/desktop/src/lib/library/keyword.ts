// `:word` in the message box also offers GIFs and stickers whose keywords start with the
// word. Unlike emoji shortcodes (ASCII only) a keyword may be any letters: `:سلام`.

import { shortcodeQuery } from "@/lib/emoji/shortcodes";

/** The `:word` before the caret, at least two letters or digits. Null inside code. */
export function keywordQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  // shortcodeQuery knows about code spans; an ASCII word is its case too.
  const ascii = shortcodeQuery(text, caret);
  if (ascii) return ascii;
  if ((before.match(/`/g)?.length ?? 0) % 2 === 1) return null;
  const match = /(?:^|[\s(]):([\p{L}\p{N}_\-]{2,})$/u.exec(before);
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
}

/** The text with the `:word` taken out, for when a GIF or sticker is picked from it. */
export function withoutKeyword(text: string, token: { start: number; query: string }): string {
  const end = token.start + 1 + token.query.length;
  return (text.slice(0, token.start) + text.slice(end)).replace(/[ \t]{2,}/g, " ");
}
