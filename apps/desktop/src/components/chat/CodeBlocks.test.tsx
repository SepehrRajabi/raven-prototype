import { beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageText } = await import("./MessageText");
const { loadHighlighter } = await import("@/lib/chat/highlight");

describe("fenced code in a message", () => {
  beforeAll(() => loadHighlighter());

  test("is coloured when the fence names a language", () => {
    const html = renderToStaticMarkup(<MessageText body={'```go\nfunc main() { return "hi" }\n```'} />);
    expect(html).toContain('<span class="rv-code-keyword">func</span>');
    expect(html).toContain('<span class="rv-code-string">&quot;hi&quot;</span>');
  });

  test("stays plain without a language or with an unknown one", () => {
    for (const fence of ["```", "```notalanguage"]) {
      const html = renderToStaticMarkup(<MessageText body={`${fence}\nfunc main() {}\n\`\`\``} />);
      expect(html).toContain("func main() {}");
      expect(html).not.toContain("rv-code-");
    }
  });

  test("never treats the code as markup", () => {
    const html = renderToStaticMarkup(<MessageText body={'```html\n<img src=x onerror="alert(1)">\n```'} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;");
    expect(html).toContain("rv-code-");
  });
});
