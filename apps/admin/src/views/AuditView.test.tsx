import { withDom } from "../test/dom";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { AdminApi, AuditFilter, AuditPage } from "../api";
import type { AuditEvent } from "../types";
import { buttonNamed, deferred, render, settle } from "../test/render";
import { AuditView } from "./AuditView";

withDom();

function events(entityType: string, count: number, from = 0): AuditEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${entityType}-${from + index}`,
    actorLabel: "root",
    action: entityType === "user" ? "user.updated" : "space.settings_changed",
    entityType,
    entityId: `${entityType}-entity-${from + index}`,
    entityLabel: `${entityType} label ${from + index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - (from + index) * 1000).toISOString(),
  }));
}

/** An api whose audit answers arrive when the test says, one queue per request. */
function fakeApi() {
  const calls: Array<{ filter: AuditFilter; answer: ReturnType<typeof deferred<AuditPage>> }> = [];
  const api = {
    auditPage: (filter: AuditFilter) => {
      const answer = deferred<AuditPage>();
      calls.push({ filter, answer });
      return answer.promise;
    },
  } as unknown as AdminApi;
  return { api, calls };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("AuditView", () => {
  test("drops an older page that was asked for under the previous filter", async () => {
    const { api, calls } = fakeApi();
    const view = await render(<AuditView api={api} />);
    const select = view.container.querySelector("select") as HTMLSelectElement;

    await choose(select, "user");
    const userFirst = calls.at(-1)!;
    expect(userFirst.filter).toEqual({ entityType: "user" });
    userFirst.answer.resolve({ events: events("user", 100), before: "cursor-user-1" });
    await settle();

    await act(async () => buttonNamed(view.container, "Show older")!.click());
    const userOlder = calls.at(-1)!;
    expect(userOlder.filter).toEqual({ entityType: "user", before: "cursor-user-1" });

    await choose(select, "space");
    const spaceFirst = calls.at(-1)!;
    expect(spaceFirst.filter).toEqual({ entityType: "space" });
    spaceFirst.answer.resolve({ events: events("space", 3), before: null });
    await settle();

    // The user page arrives late and must not join the spaces list.
    userOlder.answer.resolve({ events: events("user", 50, 100), before: null });
    await settle();
    expect(view.text()).toContain("space label 0");
    expect(view.text()).not.toContain("user label");
    expect(buttonNamed(view.container, "Show older")).toBeUndefined();
    await view.unmount();
  });

  test("follows the cursor the server gives and stops when it is null", async () => {
    const { api, calls } = fakeApi();
    const view = await render(<AuditView api={api} />);
    calls[0].answer.resolve({ events: events("user", 100), before: "c1" });
    await settle();
    await act(async () => buttonNamed(view.container, "Show older")!.click());
    expect(calls.at(-1)!.filter.before).toBe("c1");
    // One event repeats across the boundary; it is shown once.
    calls.at(-1)!.answer.resolve({ events: events("user", 10, 99), before: null });
    await settle();
    expect(view.container.querySelectorAll("li").length).toBe(109);
    expect(buttonNamed(view.container, "Show older")).toBeUndefined();
    await view.unmount();
  });
});
