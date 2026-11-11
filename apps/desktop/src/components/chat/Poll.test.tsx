import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, ChatPoll } from "@/lib/chat/types";
if (typeof globalThis.localStorage === "undefined") {
  Object.assign(globalThis, { localStorage: { getItem: () => null, setItem: () => undefined } });
}
const { MessageRow } = await import("./MessageRow");
const { pollKind, quizOutcome } = await import("./Poll");
const { pollProblem } = await import("./PollDialog");
const { messageExcerpt, pollLimits, summaryOf } = await import("@/lib/chat/attachments");

const base: ChatPoll = {
  multiple: false,
  anonymous: false,
  quiz: false,
  revealed: false,
  options: [
    { text: "Pizza", votes: 1, voterIds: ["sara"] },
    { text: "Sushi", votes: 3, voterIds: ["a", "b", "c"] },
  ],
  voters: 4,
  myVotes: [],
};
const message: ChatMessage = {
  id: "m1", conversationId: "c1", seq: 1, changedSeq: 1, senderId: "sara", senderName: "Sara", clientMessageId: "client1", kind: "text",
  body: "Where to?", poll: base, createdAt: "2026-11-11T12:00:00Z",
};
const noop = () => undefined;
function render(poll: Partial<ChatPoll>, mine = false) {
  return renderToStaticMarkup(
    <MessageRow message={{ ...message, poll: { ...base, ...poll } }} mine={mine} me="me" withAvatars={false} showSender={false} continuation={false} canReply canEdit={false} canDeleteForEveryone={false} onReply={noop} onEdit={noop} onRemoveForMe={noop} onDeleteForEveryone={noop} onOpenReply={noop} onOpenImage={noop} onVote={() => Promise.resolve()} />,
  );
}

const quiz = (myVotes: number[], multiple = false): ChatPoll => ({
  ...base,
  quiz: true,
  revealed: true,
  multiple,
  myVotes,
  options: [
    { text: "2", votes: 0, correct: false },
    { text: "4", votes: 0, correct: true },
    { text: "four", votes: 0, correct: true },
  ],
});

describe("polls", () => {
  test("hide results until you vote, then show them", () => {
    const before = render({});
    expect(before).toContain("Where to?");
    expect(before).toContain("Pizza");
    expect(before).not.toContain("75%");
    const after = render({ myVotes: [1] });
    expect(after).toContain("75%");
    expect(after).toContain("25%");
    expect(after).toContain("Take back vote");
  });

  test("show results to whoever asked", () => {
    expect(render({}, true)).toContain("75%");
  });

  test("mark right and wrong answers in a quiz", () => {
    const html = render(quiz([0]));
    expect(html).toContain(", wrong answer");
    expect(html).toContain(", correct answer");
    expect(html).toContain("Not quite.");
    expect(html).not.toContain("Take back vote");
  });

  test("say how a quiz went", () => {
    expect(quizOutcome(quiz([1]))).toBe("right");
    expect(quizOutcome(quiz([0]))).toBe("wrong");
    expect(quizOutcome(quiz([1, 2], true))).toBe("right");
    expect(quizOutcome(quiz([1], true))).toBe("partly");
    expect(quizOutcome(quiz([0, 1], true))).toBe("partly");
    expect(quizOutcome(quiz([]))).toBeNull();
    expect(quizOutcome({ ...quiz([1]), revealed: false })).toBeNull();
  });

  test("name their kind", () => {
    expect(pollKind(base)).toBe("Poll");
    expect(pollKind({ ...base, quiz: true, anonymous: true, multiple: true, closedAt: "x" })).toBe("Anonymous quiz · Choose any · Ended");
  });

  test("read as a poll in lists and quotes", () => {
    const summary = summaryOf({ poll: base });
    expect(summary).toEqual([{ kind: "poll" }]);
    expect(messageExcerpt("Where to?", summary)).toBe("Poll: Where to?");
    expect(messageExcerpt("", summary)).toBe("Poll");
    expect(messageExcerpt("hello", undefined)).toBe("hello");
  });

  test("are only offered when the server announces them", () => {
    expect(pollLimits(undefined)).toBeNull();
    expect(pollLimits({ chat: {} })).toBeNull();
    expect(pollLimits({ chat: { polls: { maxQuestionLength: 300, minOptions: 2, maxOptions: 10, maxOptionLength: 100 } } })).toEqual({ maxQuestionLength: 300, minOptions: 2, maxOptions: 10, maxOptionLength: 100 });
    expect(pollLimits({ chat: { polls: { maxQuestionLength: 300, minOptions: 12, maxOptions: 10, maxOptionLength: 100 } } })).toBeNull();
  });

  test("check what is written before sending", () => {
    const limits = { maxQuestionLength: 300, minOptions: 2, maxOptions: 10, maxOptionLength: 100 };
    const answers = (...texts: string[]) => texts.map((text) => ({ text, correct: false }));
    expect(pollProblem("", answers("a", "b"), false, limits)).toBe("Ask a question.");
    expect(pollProblem("Q?", answers("a", " "), false, limits)).toBe("Add at least 2 answers.");
    expect(pollProblem("Q?", answers("Same", "same "), false, limits)).toBe("Two answers can’t be the same.");
    expect(pollProblem("Q?", answers("a", "b"), true, limits)).toBe("Mark at least one answer as correct.");
    expect(pollProblem("Q?", [{ text: "a", correct: true }, { text: "b", correct: false }], true, limits)).toBe("");
  });
});
