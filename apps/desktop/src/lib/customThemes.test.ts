import { describe, expect, test } from "bun:test";
import {
  cleanThemeName,
  contrastRatio,
  exportThemeCss,
  nameInThemeFile,
  parseColor,
  parseStoredThemes,
  sanitizeThemeCss,
  splitThemeCss,
  themeCss,
  themeFileName,
  THEME_TOKENS,
  toHex,
  toTriple,
  type CustomTheme,
} from "./customThemes";

describe("theme files", () => {
  test("take out anything that would load from the internet", () => {
    const { css, removed } = sanitizeThemeCss(`
@import url("https://example.org/more.css");
@import "other.css";
body { background: url(https://tracker.example/pixel.png) }
input[value^="a"] { background-image: url('http://example.org/a') }
.logo { background: url("data:image/png;base64,AAAA") }
.hero { background: image-set("https://example.org/1x.png" 1x) }
`);
    expect(removed).toBe(5);
    expect(css).not.toContain("example");
    expect(css).toContain("data:image/png;base64,AAAA");
  });

  test("refuse CSS escapes, which could spell url( out of sight, but allow them in strings and comments", () => {
    expect(() => sanitizeThemeCss(`.a { background: \\75 rl(https://example.org/x) }`)).toThrow("escapes");
    expect(sanitizeThemeCss(`/* don't \\ mind */ .a::before { content: "\\201C" }`).removed).toBe(0);
  });

  test("can't be fooled by comment signs in strings, brackets in strings, or nested brackets", () => {
    expect(() => sanitizeThemeCss(`a{content:"/*"} body{background:\\75rl(https://evil.example/p.png)} b{content:"*/"}`)).toThrow("escapes");
    const tricks = [
      `body{background-image:image-set("https://evil.example/x.png?)" 1x)}`,
      `body{background-image:image-set("https://evil.example/x.png" 1x, linear-gradient(red, rgb(0 0 0)) 2x)}`,
      `body{background-image:-webkit-image-set('https://evil.example/x.png' 1x)}`,
      `body{background-image:cross-fade(url(https://evil.example/a.png), url("data:image/png;base64,AA"), 50%)}`,
      `body{background-image:image("https://evil.example/x.png")}`,
      `@font-face{font-family:x;src:url(https://evil.example/f.woff2)}`,
    ];
    for (const css of tricks) {
      const result = sanitizeThemeCss(css);
      expect(result.css).not.toContain("evil.example");
      expect(result.removed).toBeGreaterThan(0);
    }
    expect(sanitizeThemeCss(`[data-rv="button"]{font-family:"Geist", serif}`).removed).toBe(0);
  });

  test("refuse files that are too large", () => {
    expect(() => sanitizeThemeCss("a".repeat(300 * 1024))).toThrow("KB");
  });

  test("read the colours Raven knows out of :root and keep the rest", () => {
    const { tokens, extraCss } = splitThemeCss(`:root {
  --background: 222 22% 15.5%;
  --switch-on: #FFCC66 !important;
  --my-own: red;
}
.rv-code-keyword { color: #FFAD66; }`);
    expect(tokens).toEqual({ background: "222 22% 15.5%", "switch-on": "#FFCC66" });
    expect(extraCss).toContain("--my-own: red;");
    expect(extraCss).toContain(".rv-code-keyword");
    expect(extraCss).not.toContain("--background");
    expect(splitThemeCss(":root {\n  --card: #000; /* note */\n}").extraCss).toBe("");
  });

  test("leave :root inside @media, :root shared with other selectors, and values it can't read as they are", () => {
    const media = `@media (prefers-color-scheme: light) { :root { --background: 0 0% 100%; } }`;
    expect(splitThemeCss(media)).toEqual({ tokens: {}, extraCss: media });
    const grouped = `html, :root { --background: #000 } body { color: red }`;
    expect(splitThemeCss(grouped)).toEqual({ tokens: {}, extraCss: grouped });
    const { tokens, extraCss } = splitThemeCss(`:root { --base: 0 0% 5%; --background: var(--base); --card: #111; }`);
    expect(tokens).toEqual({ card: "#111" });
    expect(extraCss).toContain("--background: var(--base)");
    expect(extraCss).toContain("--base: 0 0% 5%");
  });

  test("write Raven's own tokens as H S% L% and part tokens as given", () => {
    const css = themeCss({ tokens: { background: "#1F2430", "switch-on": "#FFCC66", foreground: "nonsense" }, extraCss: ".x { color: red; }" });
    expect(css).toContain("--background: 222.4 21.5% 15.5%;");
    expect(css).toContain("--switch-on: #FFCC66;");
    expect(css).not.toContain("--foreground");
    // The colours come after the rest, so the editor's values win.
    expect(css.trim().startsWith(".x { color: red; }")).toBe(true);
  });

  test("keep the name through export and load", () => {
    const theme: CustomTheme = { id: "1", name: "Ayu Mirage", tokens: { card: "#242936" }, extraCss: "", origin: "editor", updatedAt: "" };
    const file = exportThemeCss(theme);
    expect(nameInThemeFile(file)).toBe("Ayu Mirage");
    expect(splitThemeCss(sanitizeThemeCss(file).css).tokens.card).toBe("223.3 20% 17.6%");
    expect(themeFileName("Ayu Mirage!")).toBe("ayu-mirage.css");
    expect(themeFileName("  ")).toBe("raven-theme.css");
  });

  test("tidy names", () => {
    expect(cleanThemeName("  Night\n  owl  ")).toBe("Night owl");
    expect(cleanThemeName("   ")).toBe("Untitled theme");
    expect(cleanThemeName("x".repeat(100))).toHaveLength(60);
  });
});

describe("colours", () => {
  test("read hex, H S% L%, hsl() and rgb()", () => {
    expect(toHex(parseColor("#fc6")!)).toBe("#FFCC66");
    expect(toHex(parseColor("40 100% 70%")!)).toBe("#FFCC66");
    expect(toHex(parseColor("hsl(40 100% 70%)")!)).toBe("#FFCC66");
    expect(toHex(parseColor("rgb(255, 204, 102)")!)).toBe("#FFCC66");
    expect(parseColor("tomato")).toBeNull();
    expect(toTriple(parseColor("#FFCC66")!)).toBe("40 100% 70%");
  });

  test("measure contrast as WCAG does", () => {
    expect(contrastRatio(parseColor("#000")!, parseColor("#fff")!)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#777")!, parseColor("#777")!)).toBeCloseTo(1, 5);
  });

  test("every part token falls back to a token Raven has, and every contrast pair exists", () => {
    const names = new Set(THEME_TOKENS.map((token) => token.name));
    for (const token of THEME_TOKENS) {
      if (token.kind === "color") expect(names.has(token.fallback!.token)).toBe(true);
      if (token.on) expect(names.has(token.on)).toBe(true);
    }
  });
});

describe("kept themes", () => {
  test("drop what can't be read, and an active id that points nowhere", () => {
    const good = { id: "a", name: "A", tokens: { card: "#000000" }, extraCss: "", origin: "file", updatedAt: "x" };
    const stored = parseStoredThemes(JSON.stringify({ themes: [good, { id: 3 }, { ...good, id: "b", tokens: { card: 4 } }], activeId: "b" }));
    expect(stored.themes.map((theme) => theme.id)).toEqual(["a"]);
    expect(stored.activeId).toBeNull();
    expect(parseStoredThemes("{nope")).toEqual({ themes: [], activeId: null });
  });
});
