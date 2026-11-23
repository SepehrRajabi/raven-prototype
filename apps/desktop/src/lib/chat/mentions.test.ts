import { describe, expect, test } from "bun:test";
import { labelsForPreference } from "@/shells/ravenv1/state";
import { parseMessage } from "./format";
import { filterCandidates, fromTokens, mentionPlainText, mentionQuery, mentionsAsText, mentionsUser, removedNestText, toTokens, type MentionResolver } from "./mentions";

const members = [
  { id: "u1", username: "sara" },
  { id: "u2", username: "sam" },
];

function resolver(nestSingular = "Nest"): MentionResolver {
  return {
    nestSingular,
    person: (id) => (id === "u1" ? { name: "Sara Ahmadi", username: "sara" } : id === "u2" ? { name: "Sam", username: "sam" } : null),
    nest: (target, id) => (target === "nest" && id === "v1" ? { name: "Standup", kind: "voice", people: [] } : target === "text" && id === "t1" ? { name: "general", kind: "text", people: [] } : null),
  };
}

describe("composer tokens", () => {
  test("picked names become tokens and come back as names", () => {
    const picked = [
      { text: "@Sara Ahmadi", token: "<@u:u1>" },
      { text: "@Standup", token: "<@n:v1>" },
      { text: "@general", token: "<@t:t1>" },
    ];
    const typed = "@Sara Ahmadi, join @Standup or @general.";
    const body = toTokens(typed, picked, members);
    expect(body).toBe("<@u:u1>, join <@n:v1> or <@t:t1>.");
    const back = fromTokens(body, resolver());
    expect(back.text).toBe(typed);
    expect(back.picked).toEqual(picked);
    expect(toTokens(back.text, back.picked, members)).toBe(body);
  });

  test("an exact typed @username of a member is a mention; anything else stays text", () => {
    expect(toTokens("@sam hi @Sara @samuel email@sam.example, @sam.", [], members)).toBe("<@u:u2> hi <@u:u1> @samuel email@sam.example, <@u:u2>.");
  });

  test("a picked name that is part of a longer word is left alone", () => {
    expect(toTokens("@Sam and @Samantha", [{ text: "@Sam", token: "<@u:u2>" }], [])).toBe("<@u:u2> and @Samantha");
  });

  test("code is never touched", () => {
    const picked = [{ text: "@Sam", token: "<@u:u2>" }];
    expect(toTokens("`@Sam` @Sam\n```\n@sam\n```", picked, members)).toBe("`@Sam` <@u:u2>\n```\n@sam\n```");
    expect(fromTokens("`<@u:u2>` <@u:u2>", resolver()).text).toBe("`<@u:u2>` @Sam");
  });

  test("an unknown token is kept as it is when editing", () => {
    expect(fromTokens("hi <@u:gone>", resolver())).toEqual({ text: "hi <@u:gone>", picked: [] });
  });
});

describe("mention helpers", () => {
  test("whether a message mentions someone, outside code", () => {
    expect(mentionsUser("hey <@u:u1>", "u1")).toBe(true);
    expect(mentionsUser("hey <@u:u1>", "u2")).toBe(false);
    expect(mentionsUser("`<@u:u1>`", "u1")).toBe(false);
    expect(mentionsUser("<@n:u1>", "u1")).toBe(false);
  });

  test("the @word being typed", () => {
    expect(mentionQuery("hi @sa", 6)).toEqual({ start: 3, query: "sa" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("email@sa", 8)).toBeNull();
    expect(mentionQuery("hi @sa there", 12)).toBeNull();
  });

  test("filtering ignores case and accents, names first", () => {
    const candidates = [
      { target: "user" as const, id: "a", name: "Zoë", username: "zoe" },
      { target: "user" as const, id: "b", name: "Bob Zoellner", username: "bob" },
      { target: "user" as const, id: "c", name: "Carol", username: "carol" },
    ];
    expect(filterCandidates(candidates, "ZOE").map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(filterCandidates(candidates, "").map((candidate) => candidate.id)).toEqual(["a", "b", "c"]);
  });

  test("words follow the reader's labels", () => {
    const nests = resolver(labelsForPreference("tree_nest").nestSingular);
    const rooms = resolver(labelsForPreference("space_room").nestSingular);
    expect(removedNestText(nests)).toBe("a removed nest");
    expect(removedNestText(rooms)).toBe("a removed room");
    const [block] = parseMessage("<@n:gone> <@u:gone> <@t:t1>");
    const plain = block.type === "paragraph" ? block.children.map((node) => (node.type === "mention" ? mentionPlainText(node, rooms) : node.type === "text" ? node.text : "")).join("") : "";
    expect(plain).toBe("a room someone general");
    expect(labelsForPreference("space_room").nestPlural).toBe("Rooms");
  });
});

describe("quoted excerpts", () => {
  test("name what was mentioned instead of showing its token", () => {
    expect(mentionsAsText("Poll in chats <@u:u1>, see <@n:v1> and <@t:t1>", resolver())).toBe("Poll in chats Sara Ahmadi, see Standup and general");
    expect(mentionsAsText("شد؟ <@u:u2>", resolver())).toBe("شد؟ Sam");
    expect(mentionsAsText("<@u:gone> in <@n:gone>", resolver())).toBe("someone in a nest");
    expect(mentionsAsText("<@u:u1>", undefined)).toBe("someone");
  });

  test("never show part of a token the excerpt was cut inside", () => {
    for (const cut of ["<@…", "<@u…", "<@u:…", "<@u:cc8a59fd…"]) expect(mentionsAsText(`Ask ${cut}`, resolver())).toBe("Ask …");
  });

  test("leave code and ordinary text as written", () => {
    expect(mentionsAsText("write `<@u:u1>` here <@u:u1>", resolver())).toBe("write `<@u:u1>` here Sara Ahmadi");
    expect(mentionsAsText("a < b and mail me@x…", resolver())).toBe("a < b and mail me@x…");
  });
});
