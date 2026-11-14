// Release notes are small markdown files (docs/release-notes/X.Y.Z.md): headings, paragraphs,
// bullet lists, and inline `code`, **bold** and [links](https://…). Nothing else is parsed.

export type NotesBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

export type NotesInline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

export function parseNotes(markdown: string): NotesBlock[] {
  const blocks: NotesBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push({ kind: "list", items: list });
    paragraph = [];
    list = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
    } else if (bullet) {
      if (paragraph.length) flush();
      (list ??= []).push(bullet[1]);
    } else if (list && /^\s/.test(raw)) {
      list[list.length - 1] += ` ${line}`;
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function parseInline(text: string): NotesInline[] {
  const parts: NotesInline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push({ kind: "text", text: text.slice(last, match.index) });
    if (match[1] != null) parts.push({ kind: "code", text: match[1] });
    else if (match[2] != null) parts.push({ kind: "bold", text: match[2] });
    else parts.push({ kind: "link", text: match[3], href: match[4] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
