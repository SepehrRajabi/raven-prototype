// Colours the code in a fenced block whose opening fence names a language ("```go").
//
// The highlighter (lowlight, built on highlight.js) is loaded the first time such a block
// is drawn, so chat starts without it. Its output is a tree, which is flattened here into
// runs of plain text with a colour class. React draws those as text: nothing is ever
// handled as HTML. A block with no language, or one the highlighter doesn't know, stays
// plain, because guessing a language is slow and often wrong.

import { useEffect, useMemo, useSyncExternalStore } from "react";

type Lowlight = ReturnType<(typeof import("lowlight"))["createLowlight"]>;
/** A node of the tree the highlighter returns (hast). */
type HighlightNode = ReturnType<Lowlight["highlight"]>["children"][number];

/** A stretch of code drawn in one colour. Text without a class is drawn as plain code. */
export interface CodeRun {
  text: string;
  className?: string;
}

/**
 * highlight.js scopes, grouped into the few colours a chat message needs. A scope not
 * listed here (punctuation, operators, plain identifiers) stays in the text colour.
 */
const SCOPE_CLASSES: Record<string, string> = {
  keyword: "rv-code-keyword",
  "selector-tag": "rv-code-keyword",
  doctag: "rv-code-keyword",
  string: "rv-code-string",
  regexp: "rv-code-string",
  symbol: "rv-code-string",
  char: "rv-code-string",
  link: "rv-code-string",
  number: "rv-code-number",
  literal: "rv-code-number",
  comment: "rv-code-comment",
  quote: "rv-code-comment",
  title: "rv-code-title",
  type: "rv-code-title",
  built_in: "rv-code-title",
  class: "rv-code-title",
  tag: "rv-code-title",
  name: "rv-code-title",
  section: "rv-code-title",
  attr: "rv-code-attr",
  attribute: "rv-code-attr",
  property: "rv-code-attr",
  variable: "rv-code-attr",
  "template-variable": "rv-code-attr",
  "selector-class": "rv-code-attr",
  "selector-id": "rv-code-attr",
  params: "rv-code-attr",
  meta: "rv-code-meta",
  addition: "rv-code-addition",
  deletion: "rv-code-deletion",
};

/** The colour for an element's classes: its first "hljs-" scope, e.g. "hljs-title function_". */
function scopeClass(className: unknown): string | undefined {
  if (!Array.isArray(className)) return undefined;
  for (const name of className) {
    if (typeof name === "string" && name.startsWith("hljs-")) return SCOPE_CLASSES[name.slice(5)];
  }
  return undefined;
}

/** Flattens the highlighter's tree; an inner scope's colour wins over the one around it. */
export function flattenHighlight(nodes: readonly HighlightNode[], inherited?: string, out: CodeRun[] = []): CodeRun[] {
  for (const node of nodes) {
    if (node.type === "text") {
      const last = out[out.length - 1];
      if (last && last.className === inherited) last.text += node.value;
      else out.push(inherited ? { text: node.value, className: inherited } : { text: node.value });
    } else if (node.type === "element") {
      flattenHighlight(node.children, scopeClass(node.properties?.className) ?? inherited, out);
    }
  }
  return out;
}

let lowlight: Lowlight | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Loads the highlighter once. If loading fails, code blocks simply stay plain. */
export function loadHighlighter(): Promise<void> {
  loading ??= import("lowlight")
    .then(({ createLowlight, common }) => {
      lowlight = createLowlight(common);
      for (const listener of listeners) listener();
    })
    .catch(() => {});
  return loading;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isLoaded = () => lowlight !== null;

// Messages are re-drawn as people scroll, so each block is highlighted once.
const CACHE_LIMIT = 200;
const cache = new Map<string, CodeRun[] | null>();

/** The runs for `text` in `language`, or null when it isn't loaded or isn't a known language. */
export function highlightCode(language: string, text: string): CodeRun[] | null {
  if (!lowlight || !lowlight.registered(language)) return null;
  const key = `${language}\n${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let runs: CodeRun[] | null;
  try {
    runs = flattenHighlight(lowlight.highlight(language, text).children);
  } catch {
    runs = null;
  }
  cache.set(key, runs);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return runs;
}

/** Highlighted runs for a code block, once the highlighter has loaded; null until then. */
export function useHighlightedCode(language: string | undefined, text: string): CodeRun[] | null {
  const loaded = useSyncExternalStore(subscribe, isLoaded, isLoaded);
  useEffect(() => {
    if (language && !loaded) void loadHighlighter();
  }, [language, loaded]);
  return useMemo(() => (loaded && language ? highlightCode(language, text) : null), [loaded, language, text]);
}
