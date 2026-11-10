import type {
  AdminLibraryItem,
  AdminSpace,
  AdminUser,
  AuditEvent,
  AccountSettings,
  CapabilityDefault,
  CapabilityMode,
  CapabilityName,
  Overview,
  SessionUser,
  SpaceDetail,
  UserDetail,
  UserRole,
} from "./types";

// The session lives in sessionStorage: it ends when the tab is closed, and nothing is
// left on a shared machine. The API is always on this page's own origin.
const SESSION_KEY = "raven.admin.session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasonCode = "",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SpaceSettings {
  name?: string;
  description?: string;
  joinPolicy?: "free" | "request";
  visibility?: "public" | "private";
}

const id = encodeURIComponent;

export class AdminApi {
  /** Called when the server no longer accepts the session, so the app can show sign-in. */
  onSignedOut: () => void = () => {};

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly storage: KeyValueStore,
  ) {}

  get signedIn(): boolean {
    return Boolean(this.storage.getItem(SESSION_KEY));
  }

  private async request<T>(method: string, path: string, body?: unknown, file?: Blob): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const session = this.storage.getItem(SESSION_KEY);
    if (session) headers["X-Session-ID"] = session;
    let payload: BodyInit | undefined;
    if (file) {
      headers["Content-Type"] = file.type;
      payload = file;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(path, { method, headers, body: payload, cache: "no-store" });
    } catch {
      throw new ApiError("Couldn’t reach the server. Check your connection and try again.", 0);
    }
    // The server hands back the session id on every request, and a new one at sign-in.
    const next = response.headers.get("X-Session-ID");
    if (next) this.storage.setItem(SESSION_KEY, next);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        data = JSON.parse(text) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    if (!response.ok) {
      const message = typeof data.error === "string" && data.error ? data.error : "Something went wrong. Try again.";
      const reasonCode = typeof data.reasonCode === "string" ? data.reasonCode : "";
      if (response.status === 401 && path !== "/v1/auth/login") {
        this.storage.removeItem(SESSION_KEY);
        this.onSignedOut();
      }
      throw new ApiError(message, response.status, reasonCode);
    }
    return data as T;
  }

  // Signing in

  async signIn(username: string, password: string): Promise<SessionUser> {
    const { user } = await this.request<{ user: SessionUser }>("POST", "/v1/auth/login", { username, password });
    return this.requireAdmin(user);
  }

  async me(): Promise<SessionUser> {
    const { user } = await this.request<{ user: SessionUser }>("GET", "/v1/auth/me");
    return this.requireAdmin(user);
  }

  private async requireAdmin(user: SessionUser): Promise<SessionUser> {
    if (user.role !== "admin") {
      // The session is real but of no use here, so it is not kept.
      await this.signOut();
      throw new ApiError("This account isn’t an administrator.", 403, "not_admin");
    }
    return user;
  }

  async signOut(): Promise<void> {
    try {
      if (this.signedIn) await this.request<void>("POST", "/v1/auth/logout");
    } catch {
      // Signing out here is what matters; the server session expires on its own.
    } finally {
      this.storage.removeItem(SESSION_KEY);
    }
  }

  async changeOwnPassword(currentPassword: string, newPassword: string): Promise<SessionUser> {
    const { user } = await this.request<{ user: SessionUser }>("POST", "/v1/auth/password", { currentPassword, newPassword });
    return user;
  }

  // Overview, settings, audit

  async overview(): Promise<Overview> {
    return (await this.request<{ overview: Overview }>("GET", "/v1/admin/overview")).overview;
  }

  async capabilityDefaults(): Promise<CapabilityDefault[]> {
    return (await this.request<{ capabilities: CapabilityDefault[] }>("GET", "/v1/admin/settings/capabilities")).capabilities;
  }

  async setCapabilityDefaults(capabilities: CapabilityDefault[]): Promise<CapabilityDefault[]> {
    return (await this.request<{ capabilities: CapabilityDefault[] }>("POST", "/v1/admin/settings/capabilities", { capabilities })).capabilities;
  }

  accountSettings(): Promise<AccountSettings> {
    return this.request("GET", "/v1/admin/settings/accounts");
  }

  setAccountSettings(settings: AccountSettings): Promise<AccountSettings> {
    return this.request("POST", "/v1/admin/settings/accounts", settings);
  }

  async uploadServerImage(image: Blob): Promise<void> {
    await this.request<unknown>("POST", "/v1/admin/server/avatar", undefined, image);
  }

  async audit(filter: { entityType?: string; entityId?: string; actor?: string; before?: string } = {}): Promise<AuditEvent[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) {
      if (value) query.set(key, value);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return (await this.request<{ events: AuditEvent[] }>("GET", `/v1/admin/audit${suffix}`)).events;
  }

  // Users

  async users(query = "", status = ""): Promise<AdminUser[]> {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim());
    if (status) params.set("status", status);
    const suffix = params.size > 0 ? `?${params}` : "";
    return (await this.request<{ users: AdminUser[] }>("GET", `/v1/admin/users${suffix}`)).users;
  }

  createUser(input: { username: string; displayName: string; role: UserRole }): Promise<{ user: AdminUser; temporaryPassword: string }> {
    return this.request("POST", "/v1/admin/users", input);
  }

  user(userId: string): Promise<UserDetail> {
    return this.request("GET", `/v1/admin/users/${id(userId)}`);
  }

  updateUser(userId: string, change: { displayName?: string; role?: UserRole }): Promise<UserDetail> {
    return this.request("POST", `/v1/admin/users/${id(userId)}`, change);
  }

  async uploadUserImage(userId: string, image: Blob): Promise<void> {
    await this.request<unknown>("POST", `/v1/admin/users/${id(userId)}/avatar`, undefined, image);
  }

  removeUserImage(userId: string): Promise<void> {
    return this.request("DELETE", `/v1/admin/users/${id(userId)}/avatar`);
  }

  /** Puts a plain-text message from the server admin in people's Raven contact. */
  sendMessage(to: "all" | string[], text: string): Promise<{ sent: number; skipped: number }> {
    return this.request("POST", "/v1/admin/messages", { to, text });
  }

  suspendUser(userId: string, reason: string): Promise<UserDetail> {
    return this.request("POST", `/v1/admin/users/${id(userId)}/suspend`, { reason });
  }

  reactivateUser(userId: string): Promise<UserDetail> {
    return this.request("POST", `/v1/admin/users/${id(userId)}/reactivate`);
  }

  async resetPassword(userId: string): Promise<string> {
    const result = await this.request<{ temporaryPassword: string }>("POST", `/v1/admin/users/${id(userId)}/password-reset`);
    return result.temporaryPassword;
  }

  setUserCapability(userId: string, capability: CapabilityName, mode: CapabilityMode, limit: number | null): Promise<UserDetail> {
    return this.request("POST", `/v1/admin/users/${id(userId)}/capabilities`, {
      capabilities: [{ capability, mode, limit }],
    });
  }

  revokeSessions(userId: string): Promise<void> {
    return this.request("DELETE", `/v1/admin/users/${id(userId)}/sessions`);
  }

  revokeSession(userId: string, sessionId: string): Promise<void> {
    return this.request("DELETE", `/v1/admin/users/${id(userId)}/sessions/${id(sessionId)}`);
  }

  // GIFs and stickers people have published

  async publicLibrary(query = ""): Promise<AdminLibraryItem[]> {
    const suffix = query.trim() ? `?q=${id(query.trim())}` : "";
    return (await this.request<{ items: AdminLibraryItem[] }>("GET", `/v1/admin/library/public${suffix}`)).items;
  }

  async unpublishLibraryItem(itemId: string): Promise<void> {
    await this.request("POST", `/v1/admin/library/items/${id(itemId)}/unpublish`);
  }

  async deleteLibraryItem(itemId: string): Promise<void> {
    await this.request("DELETE", `/v1/admin/library/items/${id(itemId)}`);
  }

  /** The picture an admin sees for a public item: the poster of a GIF, the sticker itself. */
  async libraryPreview(assetId: string, variant: "play" | "poster"): Promise<Blob> {
    const headers: Record<string, string> = {};
    const session = this.storage.getItem(SESSION_KEY);
    if (session) headers["X-Session-ID"] = session;
    const response = await this.fetchImpl(`/v1/admin/library/assets/${id(assetId)}/${variant}`, { headers });
    if (!response.ok) throw new ApiError("Couldn’t load the preview.", response.status);
    return response.blob();
  }

  // Spaces and rooms

  async spaces(query = ""): Promise<AdminSpace[]> {
    const suffix = query.trim() ? `?q=${id(query.trim())}` : "";
    return (await this.request<{ spaces: AdminSpace[] }>("GET", `/v1/admin/spaces${suffix}`)).spaces;
  }

  createSpace(input: { name: string; description: string; ownerUsername: string }): Promise<SpaceDetail> {
    return this.request("POST", "/v1/admin/spaces", input);
  }

  space(spaceId: string): Promise<SpaceDetail> {
    return this.request("GET", `/v1/admin/spaces/${id(spaceId)}`);
  }

  updateSpace(spaceId: string, settings: SpaceSettings): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}`, settings);
  }

  deleteSpace(spaceId: string, confirmation: string): Promise<void> {
    return this.request("DELETE", `/v1/admin/spaces/${id(spaceId)}`, { confirmation });
  }

  transferSpace(spaceId: string, target: { userId?: string; username?: string }): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/transfer`, target);
  }

  addMember(spaceId: string, username: string, role: "member" | "moderator"): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/members`, { username, role });
  }

  setMemberRole(spaceId: string, userId: string, role: "member" | "moderator"): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/members/${id(userId)}/role`, { role });
  }

  setMemberName(spaceId: string, userId: string, displayName: string): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/members/${id(userId)}/name`, { displayName });
  }

  removeMember(spaceId: string, userId: string): Promise<SpaceDetail> {
    return this.request("DELETE", `/v1/admin/spaces/${id(spaceId)}/members/${id(userId)}`);
  }

  createRoom(spaceId: string, name: string, kind: "voice" | "text"): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/rooms`, { name, kind });
  }

  renameRoom(spaceId: string, roomId: string, name: string): Promise<SpaceDetail> {
    return this.request("POST", `/v1/admin/spaces/${id(spaceId)}/rooms/${id(roomId)}`, { name });
  }

  removeRoom(spaceId: string, roomId: string): Promise<SpaceDetail> {
    return this.request("DELETE", `/v1/admin/spaces/${id(spaceId)}/rooms/${id(roomId)}`);
  }
}

export function browserApi(): AdminApi {
  return new AdminApi((input, init) => fetch(input, init), window.sessionStorage);
}
