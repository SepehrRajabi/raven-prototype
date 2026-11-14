import { describe, expect, test } from "bun:test";
import { emojiOnlyCount, graphemes, parseMessage, type Block, type Inline } from "./format";
import { dayLabel, listTime, sameDay } from "./time";

/** A compact rendering of the parsed tree, so expectations read like the message. */
function show(inline: Inline[]): string {
  return inline.map((node) => {
    switch (node.type) {
      case "text": return node.text;
      case "code": return `<code>${node.text}</code>`;
      case "link": return `<a ${node.href}>${node.text}</a>`;
      case "bold": return `<b>${show(node.children)}</b>`;
      case "italic": return `<i>${show(node.children)}</i>`;
      case "strike": return `<s>${show(node.children)}</s>`;
      case "mention": return `[${node.target}:${node.id}]`;
    }
  }).join("");
}

const line = (body: string) => {
  const blocks = parseMessage(body);
  expect(blocks.length).toBe(1);
  const block = blocks[0] as Extract<Block, { type: "paragraph" }>;
  return show(block.children);
};

describe("formatting", () => {
  test("the marks people type", () => {
    expect(line("**bold** and *italic* and _also italic_ and ~~gone~~ and `code`")).toBe("<b>bold</b> and <i>italic</i> and <i>also italic</i> and <s>gone</s> and <code>code</code>");
    expect(line("**bold with *italic* inside**")).toBe("<b>bold with <i>italic</i> inside</b>");
  });

  test("marks that are not really marks stay as typed", () => {
    expect(line("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
    expect(line("a * b * c")).toBe("a * b * c");
    expect(line("**unfinished")).toBe("**unfinished");
    expect(line("lonely ` backtick")).toBe("lonely ` backtick");
    expect(line("** spaced **")).toBe("** spaced **");
    expect(line("5 ~~ 6")).toBe("5 ~~ 6");
  });

  test("nothing inside code is formatted", () => {
    expect(line("`**not bold** https://example.com`")).toBe("<code>**not bold** https://example.com</code>");
  });

  test("markup is text, never elements", () => {
    expect(line('<img src=x onerror="alert(1)"> <script>alert(1)</script>')).toBe('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(line("[click me](https://evil.example)")).toBe("[click me](<a https://evil.example/>https://evil.example</a>)");
  });

  test("each line is its own paragraph and blank lines are kept", () => {
    const blocks = parseMessage("سلام\n\nhello");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(show((blocks[1] as Extract<Block, { type: "paragraph" }>).children)).toBe("");
  });

  test("fenced code keeps its lines and its contents untouched", () => {
    const blocks = parseMessage("before\n```ts\nconst a = **1**;\n  indented\n```\nafter");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "before" }] },
      { type: "code", text: "const a = **1**;\n  indented", language: "ts" },
      { type: "paragraph", children: [{ type: "text", text: "after" }] },
    ]);
    // A fence that never closes is just text.
    expect(parseMessage("```\nnever closed").map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
  });

  test("the opening fence's first word names the language", () => {
    const language = (body: string) => (parseMessage(body)[0] as Extract<Block, { type: "code" }>).language;
    expect(language("```Go\nx\n```")).toBe("go");
    expect(language("  ```c++ main.cpp\nx\n```")).toBe("c++");
    expect(language("```\nx\n```")).toBeUndefined();
    // Not a language name: kept as code, without one.
    expect(language("```<b>\nx\n```")).toBeUndefined();
    expect(language(`\`\`\`${"a".repeat(33)}\nx\n\`\`\``)).toBeUndefined();
    expect(parseMessage("```<b>\nx\n```")).toEqual([{ type: "code", text: "x" }]);
  });
});

describe("links", () => {
  test("only addresses written out in full become links", () => {
    expect(line("see https://raven.example/docs?a=1#top now")).toBe("see <a https://raven.example/docs?a=1#top>https://raven.example/docs?a=1#top</a> now");
    expect(line("HTTP://EXAMPLE.COM")).toBe("<a http://example.com/>HTTP://EXAMPLE.COM</a>");
    expect(line("www.example.com and example.com")).toBe("www.example.com and example.com");
    expect(line("javascript:alert(1) data:text/html,x file:///c:/x ftp://x.example")).toBe("javascript:alert(1) data:text/html,x file:///c:/x ftp://x.example");
    expect(line("nothttps://example.com")).toBe("nothttps://example.com");
    expect(line("https://")).toBe("https://");
  });

  test("punctuation that follows an address is not part of it", () => {
    expect(line("Is it https://example.com/a?")).toBe("Is it <a https://example.com/a>https://example.com/a</a>?");
    expect(line("(see https://example.com/a).")).toBe("(see <a https://example.com/a>https://example.com/a</a>).");
    expect(line("https://en.wikipedia.org/wiki/Raven_(bird)")).toBe("<a https://en.wikipedia.org/wiki/Raven_(bird)>https://en.wikipedia.org/wiki/Raven_(bird)</a>");
    expect(line("ببین https://example.com/راهنما، بعد")).toBe("ببین <a https://example.com/%D8%B1%D8%A7%D9%87%D9%86%D9%85%D8%A7>https://example.com/راهنما</a>، بعد");
  });

  test("direction-changing characters cannot disguise an address", () => {
    // With a right-to-left override this would be drawn as "https://example.com/gpj.exe".
    const disguised = "https://example.com/\u202Eexe.jpg";
    const blocks = parseMessage(disguised);
    const link = (blocks[0] as Extract<Block, { type: "paragraph" }>).children[0] as Extract<Inline, { type: "link" }>;
    expect(link.type).toBe("link");
    expect(link.text).toBe("https://example.com/exe.jpg");
    expect(link.href).toBe("https://example.com/exe.jpg");
    expect(/[\u202A-\u202E\u2066-\u2069]/.test(link.text + link.href)).toBe(false);
  });

  test("an address inside formatting still links", () => {
    expect(line("**read https://example.com now**")).toBe("<b>read <a https://example.com/>https://example.com</a> now</b>");
  });
});

describe("text in any script", () => {
  test("Persian with its zero-width non-joiner passes through unchanged", () => {
    const body = "می\u200cخواهم **پررنگ** بنویسم";
    expect(line(body)).toBe("می\u200cخواهم <b>پررنگ</b> بنویسم");
  });

  test("mixed-direction text is kept in the order it was typed", () => {
    expect(line("سلام Raven نسخه 0.1.1 منتشر شد")).toBe("سلام Raven نسخه 0.1.1 منتشر شد");
  });

  test("people count characters the way they see them", () => {
    expect(graphemes("👨‍👩‍👧").length).toBe(1);
    expect(graphemes("🇮🇷🇳🇱").length).toBe(2);
    expect(graphemes("می‌خواهم").length).toBeLessThanOrEqual(8);
    expect(graphemes("é").length).toBe(1);
  });

  test("a message that is only a few emoji is recognised as such", () => {
    expect(emojiOnlyCount("👍")).toBe(1);
    expect(emojiOnlyCount(" 🎉 🎉 ")).toBe(2);
    expect(emojiOnlyCount("👨‍👩‍👧🇮🇷❤️")).toBe(3);
    expect(emojiOnlyCount("👍👍👍👍")).toBe(0);
    expect(emojiOnlyCount("ok 👍")).toBe(0);
    expect(emojiOnlyCount("123")).toBe(0);
    expect(emojiOnlyCount("")).toBe(0);
  });
});

describe("times", () => {
  const now = new Date(2026, 9, 11, 15, 0).getTime();
  const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month, day, hour).toISOString();

  test("day headings go from words to dates", () => {
    expect(dayLabel(at(2026, 9, 11, 9), now)).toBe("Today");
    expect(dayLabel(at(2026, 9, 10, 23), now)).toBe("Yesterday");
    expect(dayLabel(at(2026, 9, 8), now)).toMatch(/\w+day/);
    expect(dayLabel(at(2026, 2, 3), now)).not.toMatch(/2026/);
    expect(dayLabel(at(2025, 2, 3), now)).toMatch(/2025/);
    expect(dayLabel("not a date", now)).toBe("");
  });

  test("messages are grouped by the day they were sent", () => {
    expect(sameDay(at(2026, 9, 11, 1), at(2026, 9, 11, 23))).toBe(true);
    expect(sameDay(at(2026, 9, 11, 23), at(2026, 9, 12, 1))).toBe(false);
  });

  test("list times are short", () => {
    expect(listTime(new Date(2026, 9, 11, 9, 5).getTime(), now)).toMatch(/9[:٫.]05|09[:٫.]05/);
    expect(listTime(new Date(2026, 9, 9).getTime(), now).length).toBeLessThan(6);
    expect(listTime(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
    expect(listTime(0, now)).toBe("");
  });
});

describe("mentions", () => {
  test("tokens become mention nodes, also inside marks", () => {
    expect(line("hi <@u:abc> and <@n:v1>, <@t:t1>!")).toBe("hi [user:abc] and [nest:v1], [text:t1]!");
    expect(line("**<@u:abc>**")).toBe("<b>[user:abc]</b>");
  });

  test("inside code they stay as typed", () => {
    expect(line("`<@u:abc>`")).toBe("<code><@u:abc></code>");
    expect(parseMessage("```\n<@u:abc>\n```")).toEqual([{ type: "code", text: "<@u:abc>" }]);
  });

  test("a hand-typed token with a bad id is still a mention; anything malformed is text", () => {
    expect(line("<@u:no-such-person>")).toBe("[user:no-such-person]");
    expect(line("<@x:abc> <@u:> <@u:a b> <@u:abc")).toBe("<@x:abc> <@u:> <@u:a b> <@u:abc");
  });
});
