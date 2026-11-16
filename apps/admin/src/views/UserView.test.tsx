import { withDom } from "../test/dom";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { AdminApi } from "../api";
import type { AdminUser, SessionUser, UserDetail, UserSession } from "../types";
import { TemporaryPasswordDialog } from "../components/ui";
import { buttonNamed, render, settle } from "../test/render";
import { UserView } from "./UserView";
import { UsersView } from "./UsersView";

withDom();

const me: SessionUser = { id: "me", username: "root", displayName: "Root", role: "admin", status: "active", mustChangePassword: false };

function user(change: Partial<AdminUser> = {}): AdminUser {
  return {
    id: "u1",
    username: "bo",
    displayName: "Bo",
    role: "user",
    status: "active",
    statusReason: "",
    mustChangePassword: false,
    passwordChangedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastSeenAt: null,
    activeSessions: 0,
    spaceCount: 0,
    deleted: false,
    ...change,
  };
}

function session(id: string, change: Partial<UserSession> = {}): UserSession {
  return {
    id,
    latestIp: "192.0.2.1",
    userAgent: "",
    os: "Linux",
    deviceName: `Device ${id}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastAccessedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2027-01-01T00:00:00Z",
    ...change,
  };
}

function detail(account: AdminUser, sessions: UserSession[] = []): UserDetail {
  return {
    user: account,
    capabilities: [
      { capability: "rooms.join", mode: "inherit", limit: null, defaultAllowed: true, defaultLimit: null, effective: true, effectiveLimit: null },
    ],
    sessions,
    spaces: [],
    invitedBy: null,
  };
}

describe("UserView", () => {
  test("a deleted account says so and offers nothing to change", async () => {
    const api = { user: async () => detail(user({ id: "u1", username: "deleted-u1", displayName: "Deleted account", deleted: true })) } as unknown as AdminApi;
    const view = await render(<UserView api={api} userId="u1" me={me} />);
    await settle();
    expect(view.text()).toContain("Deleted");
    expect(view.text()).not.toContain("Active");
    expect(view.text()).toContain("This account was deleted by its owner");
    for (const action of ["Send a message", "Edit name", "Suspend", "Reset password", "Make administrator", "Sign out everywhere"]) {
      expect(buttonNamed(view.container, action)).toBeUndefined();
    }
    expect(view.container.querySelector("select")).toBeNull();
    await view.unmount();
  });

  test("marks the session this dashboard uses and offers no sign-out for it", async () => {
    const api = { user: async () => detail(user({ id: "me", username: "root" }), [session("s-current", { current: true }), session("s-other")]) } as unknown as AdminApi;
    const view = await render(<UserView api={api} userId="me" me={me} />);
    await settle();
    expect(view.text()).toContain("This device");
    expect(buttonNamed(view.container, "Sign out Device s-current")).toBeUndefined();
    expect(buttonNamed(view.container, "Sign out Device s-other")).toBeDefined();
    await view.unmount();
  });

  test("shows a failed reload next to the page it could not refresh", async () => {
    let calls = 0;
    const api = {
      user: async () => {
        calls += 1;
        if (calls > 1) throw new Error("Couldn’t reach the server.");
        return detail(user(), [session("s1")]);
      },
      revokeSession: async () => undefined,
    } as unknown as AdminApi;
    const view = await render(<UserView api={api} userId="u1" me={me} />);
    await settle();
    await act(async () => buttonNamed(view.container, "Sign out Device s1")!.click());
    await settle();
    expect(view.text()).toContain("Couldn’t refresh this page, so it may be out of date. Couldn’t reach the server.");
    // The last good copy is still there.
    expect(view.text()).toContain("Device s1");
    await view.unmount();
  });
});

describe("UsersView", () => {
  test("labels a deleted account in the list", async () => {
    const api = { users: async () => [user({ id: "u2", displayName: "Deleted account", deleted: true, status: "active", role: "admin" })] } as unknown as AdminApi;
    const view = await render(<UsersView api={api} />);
    await settle();
    const row = view.container.querySelector("li")!;
    expect(row.textContent).toContain("Deleted");
    expect(row.textContent).not.toContain("Admin");
    await view.unmount();
  });
});

describe("TemporaryPasswordDialog", () => {
  test("only Done closes it", async () => {
    let closed = 0;
    const view = await render(<TemporaryPasswordDialog username="bo" password="secret-words" onClose={() => (closed += 1)} />);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    const backdrop = document.querySelector("[role=dialog]")!.parentElement!;
    await act(async () => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(closed).toBe(0);
    expect(buttonNamed(view.container, "Close")).toBeUndefined();
    await act(async () => buttonNamed(view.container, "Done")!.click());
    expect(closed).toBe(1);
    await view.unmount();
  });
});
