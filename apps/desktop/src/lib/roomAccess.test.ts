import { describe, expect, test } from "bun:test";
import {
  changeProblem,
  changeSummary,
  endOf,
  endPayload,
  endTime,
  everyMemberLevel,
  filterGroups,
  hideCopy,
  kindsOf,
  labelDeleteCopy,
  labelNameProblem,
  labelRoomCount,
  levelCopy,
  levelName,
  listWords,
  liveRules,
  newlyHidden,
  nextEnd,
  replacedRules,
  ruleGroups,
  targetKinds,
  targetName,
  untilText,
  whyText,
  withChange,
  withoutLabel,
  withRoomLabels,
  type AccessNames,
  type AccessRule,
  type RoomLabels,
} from "./roomAccess";

const names: AccessNames = {
  nouns: { one: "room", many: "rooms" },
  room: (room) => ({ "text:t1": "general", "text:t2": "plans", "voice:v1": "Standup" })[`${room.kind}:${room.id}`],
  label: (id) => ({ staff: "Staff", quiet: "Quiet" })[id],
};
const rooms = [
  { kind: "text", id: "t1" },
  { kind: "text", id: "t2" },
  { kind: "voice", id: "v1" },
] as const;
const roomLabels: RoomLabels[] = [
  { kind: "text", id: "t2", labelIds: ["staff", "quiet"] },
  { kind: "voice", id: "v1", labelIds: ["staff"] },
];
const now = new Date(2026, 10, 24, 14, 0).getTime();
const inHours = (hours: number) => new Date(now + hours * 3_600_000).toISOString();

let made = 0;
function rule(patch: Partial<AccessRule> & Pick<AccessRule, "scope">): AccessRule {
  made += 1;
  return { id: `r${made}`, level: "none", createdAt: "", updatedAt: "", ...patch };
}

describe("words", () => {
  test("a level is named for the kinds of room it is about", () => {
    expect(levelName("none", "voice")).toBe("No access");
    expect(levelName("full", ["text", "voice"])).toBe("Full access");
    expect(levelName("view", "text")).toBe("Read only");
    expect(levelName("view", ["voice"])).toBe("Listen only");
    expect(levelName("view", ["text", "voice"])).toBe("Read or listen only");
    expect(levelName("view", [])).toBe("Read or listen only");
  });

  test("a level's explanation uses the person's own nouns", () => {
    expect(levelCopy("view", ["text", "voice"], { one: "nest", many: "nests" })).toContain("text nests");
    expect(levelCopy("view", ["voice"], names.nouns)).toContain("Microphone, camera and screen stay off");
    expect(levelCopy("none", ["text"], names.nouns)).not.toContain("call");
  });

  test("a target is named by what it reaches", () => {
    expect(targetName({ scope: "all", kind: "voice" }, names)).toBe("All voice rooms");
    expect(targetName({ scope: "label", targetId: "staff" }, names)).toBe("Label Staff");
    expect(targetName({ scope: "label" }, names)).toBe("A label");
    expect(targetName({ scope: "room", kind: "text", targetId: "t1" }, names)).toBe("general");
    expect(targetName({ scope: "room", kind: "voice", targetId: "gone" }, names)).toBe("A voice room");
  });

  test("why says who a rule is about and how close it is", () => {
    expect(whyText(undefined, "Ava", names)).toBe("Nothing set");
    expect(whyText({ scope: "room", kind: "text", targetId: "t1", everyone: false }, "Ava", names)).toBe("Set for Ava in this room");
    expect(whyText({ scope: "label", targetId: "staff", everyone: true }, "Ava", names)).toBe("Set for every member, label Staff");
    expect(whyText({ scope: "label", everyone: true }, "you", names)).toBe("Set for every member, a label");
    expect(whyText({ scope: "all", kind: "voice", everyone: false }, "you", names)).toBe("Set for you, all voice rooms");
  });

  test("lists keep to a few names", () => {
    expect(listWords([])).toBe("");
    expect(listWords(["Ava"])).toBe("Ava");
    expect(listWords(["Ava", "Sam", "Mina"])).toBe("Ava, Sam and Mina");
    expect(listWords(["Ava", "Sam", "Mina", "Lee"])).toBe("Ava, Sam and 2 others");
  });

  test("an end is a clock time near by and a date further off", () => {
    expect(endTime(inHours(1), now)).not.toContain("tomorrow");
    expect(endTime(inHours(24), now)).toEndWith(" tomorrow");
    expect(endTime(inHours(24 * 30), now)).toContain("2026");
    expect(endTime("nonsense", now)).toBe("");
    expect(untilText(undefined, now)).toBe("");
    expect(untilText(inHours(24), now)).toStartWith("Until ");
  });

  test("a summary says who, what, where and until when", () => {
    const base = { everyone: false, people: ["Ava", "Sam"], targets: [{ scope: "room" as const, kind: "text" as const, targetId: "t1" }] };
    expect(changeSummary({ ...base, level: "view" }, names, roomLabels, now)).toBe("Ava and Sam: read only in general.");
    expect(changeSummary({ ...base, level: "none" }, names, roomLabels, now)).toBe("Ava and Sam: no access to general.");
    expect(changeSummary({ ...base, level: "full", until: inHours(24) }, names, roomLabels, now)).toMatch(/^Ava and Sam: full access to general, until .* tomorrow\.$/);
    expect(changeSummary({ ...base, level: "clear" }, names, roomLabels, now)).toBe("Ava and Sam: what is set for general is removed.");
    expect(changeSummary({ everyone: true, people: [], targets: [{ scope: "all", kind: "voice" }], level: "view" }, names, roomLabels, now)).toBe("Every member: listen only in all voice rooms.");
    expect(changeSummary({ everyone: true, people: [], targets: [{ scope: "label", targetId: "quiet" }, ...base.targets], level: "view" }, names, roomLabels, now)).toBe("Every member: read only in general and rooms labelled Quiet.");
    expect(changeSummary({ ...base, people: [], level: "view" }, names, roomLabels, now)).toBe("");
  });

  test("a label reaches the kinds of room it is on, and either when it is on none", () => {
    expect(targetKinds({ scope: "label", targetId: "quiet" }, roomLabels)).toEqual(["text"]);
    expect(targetKinds({ scope: "label", targetId: "staff" }, roomLabels)).toEqual(["text", "voice"]);
    expect(targetKinds({ scope: "label", targetId: "new" }, roomLabels)).toEqual(["text", "voice"]);
    expect(kindsOf([{ scope: "all", kind: "voice" }, { scope: "label", targetId: "quiet" }], roomLabels)).toEqual(["text", "voice"]);
    expect(kindsOf([], roomLabels)).toEqual([]);
  });
});

describe("rules", () => {
  test("ended rules drop out, and the next end is the soonest one ahead", () => {
    const rules = [rule({ scope: "all", kind: "text", expiresAt: inHours(-1) }), rule({ scope: "all", kind: "voice", expiresAt: inHours(3) }), rule({ scope: "label", targetId: "staff", expiresAt: inHours(2) })];
    expect(liveRules(rules, now)).toHaveLength(2);
    expect(nextEnd(rules, now)).toBe(now + 2 * 3_600_000);
    expect(nextEnd([], now)).toBeNull();
  });

  test("every member comes first, then people in order; widest targets first", () => {
    const rules = [
      rule({ scope: "room", kind: "voice", targetId: "v1", userId: "sam" }),
      rule({ scope: "room", kind: "text", targetId: "t2" }),
      rule({ scope: "label", targetId: "quiet" }),
      rule({ scope: "all", kind: "voice" }),
      rule({ scope: "label", targetId: "staff" }),
      rule({ scope: "room", kind: "text", targetId: "t1" }),
      rule({ scope: "all", kind: "text", userId: "ava" }),
    ];
    const groups = ruleGroups(rules, { people: ["ava", "sam"], labels: ["staff", "quiet"], rooms });
    expect(groups.map((group) => group.userId)).toEqual([undefined, "ava", "sam"]);
    expect(groups[0].rules.map((entry) => entry.targetId ?? entry.kind)).toEqual(["voice", "staff", "quiet", "t1", "t2"]);
  });

  test("a filter keeps a person's rules together and otherwise picks rows", () => {
    const groups = ruleGroups([rule({ scope: "all", kind: "text" }), rule({ scope: "room", kind: "voice", targetId: "v1" }), rule({ scope: "all", kind: "text", userId: "ava" })], { people: ["ava"], labels: [], rooms });
    const person = (userId: string | undefined) => (userId ? "Ava" : "Every member");
    expect(filterGroups(groups, " ", person, names)).toHaveLength(2);
    expect(filterGroups(groups, "ava", person, names).map((group) => group.userId)).toEqual(["ava"]);
    expect(filterGroups(groups, "stand", person, names).map((group) => group.rules.length)).toEqual([1]);
    expect(filterGroups(groups, "zzz", person, names)).toEqual([]);
  });

  test("a change replaces the rules with the same subject and target, and clear removes them", () => {
    const rules = [rule({ scope: "all", kind: "text" }), rule({ scope: "all", kind: "text", userId: "ava" }), rule({ scope: "room", kind: "text", targetId: "t1", userId: "ava" })];
    const change = { userIds: ["ava", "sam"], everyone: false, targets: [{ scope: "all" as const, kind: "text" as const }] };
    expect(replacedRules(rules, change).map((entry) => entry.id)).toEqual([rules[1].id]);
    expect(withChange(rules, { ...change, level: "clear" })).toEqual([rules[0], rules[2]]);
    const set = withChange(rules, { ...change, level: "view" });
    expect(set).toHaveLength(4);
    expect(set.filter((entry) => entry.level === "view").map((entry) => entry.userId)).toEqual(["ava", "sam"]);
  });

  test("what every member has follows the closest rule, and the least of several labels", () => {
    const at = (rules: AccessRule[], room: (typeof rooms)[number]) => everyMemberLevel({ rules, roomLabels }, room, now);
    expect(at([], rooms[0])).toBe("full");
    const rules = [rule({ scope: "all", kind: "text" }), rule({ scope: "label", targetId: "staff", level: "full" }), rule({ scope: "label", targetId: "quiet", level: "view" })];
    expect(at(rules, rooms[0])).toBe("none");
    expect(at(rules, rooms[1])).toBe("view");
    expect(at(rules, rooms[2])).toBe("full");
    expect(at([...rules, rule({ scope: "room", kind: "text", targetId: "t2", level: "full" })], rooms[1])).toBe("full");
    expect(at([rule({ scope: "all", kind: "text", userId: "ava" })], rooms[0])).toBe("full");
    expect(at([rule({ scope: "all", kind: "text", expiresAt: inHours(-1) })], rooms[0])).toBe("full");
  });

  test("only rooms that a change newly hides are warned about", () => {
    const before = { rules: [rule({ scope: "room", kind: "text", targetId: "t1" })], roomLabels };
    const hide = withChange(before.rules, { userIds: [], everyone: true, targets: [{ scope: "all", kind: "text" }], level: "none" });
    expect(newlyHidden(before, { ...before, rules: hide }, rooms, now)).toEqual([{ kind: "text", id: "t2" }]);
    const one = withChange(before.rules, { userIds: ["ava"], everyone: false, targets: [{ scope: "all", kind: "text" }], level: "none" });
    expect(newlyHidden(before, { ...before, rules: one }, rooms, now)).toEqual([]);
    expect(hideCopy([{ kind: "text", id: "t2" }], names).title).toBe("Hide plans from every member?");
    expect(hideCopy([...rooms], names).title).toBe("Hide 3 rooms from every member?");
  });

  test("labelling a room can hide it, and clearing an exception can too", () => {
    const rules = [rule({ scope: "label", targetId: "staff" }), rule({ scope: "room", kind: "voice", targetId: "v1", level: "full" })];
    const labelled = withRoomLabels(roomLabels, { rooms: [{ kind: "text", id: "t1" }], add: ["staff"], remove: [] });
    expect(newlyHidden({ rules, roomLabels }, { rules, roomLabels: labelled }, rooms, now)).toEqual([{ kind: "text", id: "t1" }]);
    const cleared = withChange(rules, { userIds: [], everyone: true, targets: [{ scope: "room", kind: "voice", targetId: "v1" }], level: "clear" });
    expect(newlyHidden({ rules, roomLabels }, { rules: cleared, roomLabels }, rooms, now)).toEqual([{ kind: "voice", id: "v1" }]);
  });
});

describe("ends", () => {
  test("a duration is sent as seconds, a date as itself, and no end as neither", () => {
    expect(endPayload("none", null, now)).toEqual({});
    expect(endPayload("hour", null, now)).toEqual({ ttlSeconds: 3600 });
    expect(endPayload("date", inHours(5), now)).toEqual({ expiresAt: inHours(5) });
    expect(endPayload("keep", inHours(5), now)).toEqual({ expiresAt: inHours(5) });
    expect(endPayload("date", null, now)).toEqual({});
  });

  test("a month is a calendar month and stops at a shorter month's last day", () => {
    const january = new Date(2027, 0, 31, 9, 0).getTime();
    expect(new Date(endOf("month", null, january)!).toDateString()).toBe(new Date(2027, 1, 28).toDateString());
    expect(new Date(endOf("month", null, now)!).toDateString()).toBe(new Date(2026, 11, 24).toDateString());
    expect(new Date(endOf("week", null, now)!).toDateString()).toBe(new Date(2026, 11, 1).toDateString());
  });

  test("a change says what is missing before it can be saved", () => {
    const good = { everyone: false, userIds: ["ava"], targets: [{ scope: "all" as const, kind: "text" as const }], end: "none" as const, endAt: null, level: "view" as const };
    const problem = (patch: Partial<Parameters<typeof changeProblem>[0]>) => changeProblem({ ...good, ...patch }, names.nouns, now);
    expect(problem({})).toBe("");
    expect(problem({ userIds: [] })).toBe("Choose at least one person.");
    expect(problem({ userIds: [], everyone: true })).toBe("");
    expect(problem({ targets: [] })).toBe("Choose at least one room or label.");
    expect(problem({ userIds: Array.from({ length: 201 }, (_, index) => String(index)) })).toContain("200 people");
    expect(problem({ end: "date" })).toBe("Pick when it ends.");
    expect(problem({ end: "date", endAt: inHours(-1) })).toContain("a minute from now");
    expect(problem({ end: "date", endAt: inHours(24 * 366 * 6) })).toContain("five years");
    expect(problem({ end: "date", endAt: inHours(-1), level: "clear" })).toBe("");
    expect(problem({ end: "month" })).toBe("");
  });
});

describe("labels", () => {
  const labels = [{ id: "staff", name: "Staff", visible: false, position: 0 }];

  test("a name is needed, short enough and not taken", () => {
    expect(labelNameProblem("  ", labels)).toBe("Write a name.");
    expect(labelNameProblem(" staff ", labels)).toBe("Another label has that name.");
    expect(labelNameProblem("STAFF", labels, "staff")).toBe("");
    expect(labelNameProblem("a".repeat(41), labels)).toContain("40");
    expect(labelNameProblem("😀".repeat(40), labels)).toBe("");
  });

  test("labels are added and taken off in bulk", () => {
    const next = withRoomLabels(roomLabels, { rooms: [{ kind: "text", id: "t1" }, { kind: "text", id: "t2" }], add: ["staff"], remove: ["quiet"] });
    expect(labelRoomCount("staff", next)).toBe(3);
    expect(labelRoomCount("quiet", next)).toBe(0);
    expect(roomLabels[0].labelIds).toEqual(["staff", "quiet"]);
  });

  test("deleting one says what goes with it and what that opens or hides", () => {
    const access = { rules: [rule({ scope: "label", targetId: "quiet" })], roomLabels };
    expect(labelDeleteCopy("quiet", access, rooms, names, now)).toBe("It comes off 1 room. The rule about it goes too. Every member can then see plans.");
    expect(labelDeleteCopy("new", access, rooms, names, now)).toBe("No room has it.");
    const exception = { rules: [rule({ scope: "all", kind: "text" }), rule({ scope: "label", targetId: "quiet", level: "view" })], roomLabels };
    expect(labelDeleteCopy("quiet", exception, rooms, names, now)).toContain("Every member then loses plans.");
    expect(withoutLabel(access, "quiet").rules).toEqual([]);
  });
});
