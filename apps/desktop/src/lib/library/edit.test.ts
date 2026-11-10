import { describe, expect, test } from "bun:test";
import { addKeywords, inBatches, keywordSuggestions, validateDraft, withBackoff } from "./edit";

const draft = { title: "", keywords: [], collectionId: "", public: false };

describe("validateDraft", () => {
  test("a public item needs a title", () => {
    expect(validateDraft(draft)).toBeNull();
    expect(validateDraft({ ...draft, public: true })).toBe("Give it a title before making it public.");
    expect(validateDraft({ ...draft, public: true, title: "  " })).toBe("Give it a title before making it public.");
    expect(validateDraft({ ...draft, public: true, title: "Cat waving" })).toBeNull();
  });

  test("keeps to the server's limits", () => {
    const limits = { maxTitleLength: 5, maxKeywords: 2, maxKeywordLength: 3 };
    expect(validateDraft({ ...draft, title: "toolong" }, limits)).toBe("Titles can be up to 5 characters.");
    expect(validateDraft({ ...draft, keywords: ["a", "b", "c"] }, limits)).toBe("Up to 2 keywords.");
    expect(validateDraft({ ...draft, keywords: ["abcd"] }, limits)).toBe("Keywords can be up to 3 characters.");
  });
});

describe("keywords", () => {
  test("typed text becomes keywords without repeats", () => {
    expect(addKeywords(["cat"], " Wave, cat ,، hi")).toEqual(["cat", "wave", "hi"]);
  });

  test("suggestions come from the file name, pack title and emoji name", () => {
    expect(keywordSuggestions(["IMG_0042 cat-waving.gif", "Cats", "waving hand"], ["cat"])).toEqual(["waving", "cats", "hand"]);
  });
});

describe("batches", () => {
  test("never runs more than the limit at once", async () => {
    let running = 0;
    let most = 0;
    await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
    expect(most).toBe(3);
  });

  test("backs off on a rate limit and gives up after the last wait", async () => {
    let calls = 0;
    const limited = new Error("slow down");
    const result = await withBackoff(async () => (++calls < 3 ? Promise.reject(limited) : "ok"), (error) => error === limited, [1, 1, 1], async () => undefined);
    expect(result).toBe("ok");
    await expect(withBackoff(() => Promise.reject(limited), () => true, [1], async () => undefined)).rejects.toBe(limited);
  });
});
