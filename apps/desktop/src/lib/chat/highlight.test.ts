import { beforeAll, describe, expect, test } from "bun:test";
import { flattenHighlight, highlightCode, loadHighlighter } from "./highlight";

describe("highlighting", () => {
  beforeAll(() => loadHighlighter());

  test("keeps every character, in order", () => {
    const code = 'func main() {\n\t// say hi\n\tfmt.Println("hi", 42)\n}';
    const runs = highlightCode("go", code)!;
    expect(runs.map((run) => run.text).join("")).toBe(code);
  });

  test("colours keywords, strings, numbers and comments", () => {
    const runs = highlightCode("go", 'func main() { // hi\n\tx := "a" + 1\n}')!;
    const colourOf = (text: string) => runs.find((run) => run.text === text)?.className;
    expect(colourOf("func")).toBe("rv-code-keyword");
    expect(colourOf('"a"')).toBe("rv-code-string");
    expect(colourOf("1")).toBe("rv-code-number");
    expect(colourOf("// hi")).toBe("rv-code-comment");
  });

  test("knows common aliases", () => {
    for (const language of ["js", "ts", "py", "sh", "rs", "yml", "html", "c++", "diff"]) {
      expect(highlightCode(language, "x")).not.toBeNull();
    }
  });

  test("leaves unknown languages plain", () => {
    expect(highlightCode("notalanguage", "x")).toBeNull();
  });

  test("returns the same runs for the same block", () => {
    expect(highlightCode("ts", "let a = 1;")).toBe(highlightCode("ts", "let a = 1;"));
  });
});

describe("flattening", () => {
  test("an inner scope wins, and neighbouring text of one colour is merged", () => {
    const runs = flattenHighlight([
      { type: "text", value: "a" },
      { type: "element", tagName: "span", properties: { className: ["hljs-string"] }, children: [
        { type: "text", value: '"x' },
        { type: "element", tagName: "span", properties: { className: ["hljs-subst"] }, children: [{ type: "text", value: "${y}" }] },
        { type: "element", tagName: "span", properties: { className: ["hljs-number"] }, children: [{ type: "text", value: "2" }] },
        { type: "text", value: '"' },
      ] },
      { type: "text", value: "b" },
    ]);
    expect(runs).toEqual([
      { text: "a" },
      // "subst" has no colour of its own, so it keeps the string's.
      { text: '"x${y}', className: "rv-code-string" },
      { text: "2", className: "rv-code-number" },
      { text: '"', className: "rv-code-string" },
      { text: "b" },
    ]);
  });
});
