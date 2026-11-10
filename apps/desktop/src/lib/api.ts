import {
  readAccounts,
  removeBySession,
  sortForMenu,
  upsertAccount,
  writeAccounts,
  type SavedAccount,
} from "@/lib/accounts";
import { avatarVersion, noteAvatarRoute } from "@/lib/avatarVersions";
import { parseCallVote, type CallVote } from "@/lib/callVote";
import { normalizeApiServerUrl } from "@/lib/apiServerUrl";
import type { WorkshopConfig, WorkshopPlaceKind, WorkshopProtocol, WorkshopShare } from "@/lib/workshopState";

const DEFAULT_API_BASE_URL = normalizeApiServerUrl(import.meta.env.VITE_RAVEN_API_URL ?? "http://127.0.0.1:6977");
const API_SERVER_URL_KEY = "raven.apiServerUrl";
const API_SERVER_HISTORY_KEY = "raven.apiServerHistory";
const SESSION_ID_KEY = "raven.sessionId";
export const RAVEN_CLIENT_VERSION = typeof __RAVEN_CLIENT_VERSION__ === "string" ? __RAVEN_CLIENT_VERSION__ : "0.1.0";
export const RAVEN_CLIENT_CAPABILITIES = [
  // Tells the server this client understands chat events on the event stream.
  "chat-v1",
];

export class ApiError extends Error {
  /** How long the server asked us to wait before trying again (HTTP 429). */
  retryAfterSeconds?: number;

  constructor(
    message: string,
    readonly status: number,
    readonly reasonCode = "",
    readonly compatibility?: ServerCompatibility,
    readonly serviceAccess = "",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const updateRequiredListeners = new Set<(required: ServerCompatibility | null) => void>();

/**
 * Tells the listener when the server starts or stops refusing this version of Raven
 * (see `ApiClient.updateRequired`).
 */
export function subscribeUpdateRequired(listener: (required: ServerCompatibility | null) => void) {
  updateRequiredListeners.add(listener);
  return () => {
    updateRequiredListeners.delete(listener);
  };
}

export function isUnauthorizedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

/** What stands between a person and deleting their account. */
export interface AccountDeletionState {
  ownedTrees: { id: string; name: string }[];
  onlyAdmin: boolean;
  inCall: boolean;
}

export type UserRole = "admin" | "user";
export type NestType = "persistent" | "temporary";
export type NestRole = "creator" | "moderator" | "participant";
export type MembershipState = "invited" | "joined" | "left" | "removed";
export type TreeRole = "owner" | "moderator" | "member";
export type TreeMembershipState = "joined" | "left" | "removed";
export type TreeJoinPolicy = "free" | "request";
export type TreeVisibility = "public" | "private";
export type UserPresenceState = "offline" | "available" | "dnd" | "in_nest" | "invisible";
export type UserReachability = "open" | "around" | "focused" | "unavailable";
/** How a room lets people in. Temporary nests are always open. */
export type NestDoor = "open" | "knock" | "quiet";
export type KnockStatus = "pending" | "accepted" | "declined" | "dismissed" | "expired";
/** An answer to a knock on a person: Coming now, Coming in 10 min, Ask me later, Not today. */
export type KnockReply = "coming" | "soon" | "later" | "not_today" | "message";
export type UserRelationship = "self" | "none" | "friends" | "incoming_pending" | "outgoing_pending";
export type UILabelPreference = "tree_nest" | "space_room";

export interface NestLiveUpdate {
  type: string;
  /** The tree an update is about, when it is about one. */
  treeId?: string;
  nestId?: string;
  sessionId?: string;
  /** Who the update is about. Only present on updates addressed to specific people. */
  actorId?: string;
  actorName?: string;
  /** On "call.vote" updates, which reach only the people in that vote. */
  vote?: CallVote;
  /** On "workshop.share.*" updates: the share, and on "ended" why it ended. */
  share?: WorkshopShare;
  reason?: string;
  /** On "event.invited" and "event.reminder", which reach the event's invitees only. */
  event?: EventNotice;
  at?: string;
}

/** Updates that describe a moment rather than a change of stored state. */
export function isTransientNestUpdate(update: NestLiveUpdate) {
  return update.type === "nest.entering" || update.type === "nest.entering.cancelled";
}

export interface UserPreferences {
  displayName: string;
  uiLabels: UILabelPreference;
  colorPalette: "raven_dark";
  colorPaletteEnabled: boolean;
  alwaysJoinMuted: boolean;
  joinWithCameraOff: boolean;
  joinWithoutScreenSharing: boolean;
  /** Read by older clients, where every share was received and this brought a new one to the front. */
  followScreenShares: boolean;
  /**
   * Watch a share as soon as someone starts it. Off unless chosen; absent from servers
   * that predate it. Not derived from `followScreenShares` (which defaulted on).
   */
  watchNewShares?: boolean;
  /** Everything Raven sends to this person: event messages and the server admin's notes. On unless turned off; absent from servers that predate it. */
  ravenMessages?: boolean;
  updatedAt: string;
}

/** What the server's administrator lets an account do. See lib/permissions.ts. */
export interface UserCapabilities {
  createSpaces: boolean;
  /** How many trees the account may own; null is no limit. */
  maxOwnedSpaces: number | null;
  joinRooms: boolean;
  startRooms: boolean;
  readMessages: boolean;
  sendMessages: boolean;
  createGroups: boolean;
  /** Making invite codes; false whenever the server has Invitations turned off. */
  createInvites?: boolean;
  /** How many open invites the account may have; null is no limit. */
  maxOpenInvites?: number | null;
  /** Workshop port sharing: publishing a local port, and connecting to one. */
  sharePorts?: boolean;
  usePorts?: boolean;
}

/** One invite code as the person who made it sees it. The code itself is shown only once. */
export interface Invite {
  id: string;
  /** The code's last four characters, to tell codes apart. */
  hint: string;
  createdAt: string;
  expiresAt: string;
  state: "open" | "used" | "expired" | "revoked";
  usedAt?: string;
  usedBy?: PublicUser;
}

export interface SignUpRequest {
  username: string;
  displayName: string;
  password: string;
  inviteCode: string;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status?: "active" | "suspended";
  /** Signed in with a temporary password that has to be replaced before anything else. */
  mustChangePassword?: boolean;
  capabilities?: UserCapabilities;
  preferences: UserPreferences;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  relationship: UserRelationship;
  friendRequestId?: string;
}

export interface Nest {
  id: string;
  name: string;
  joinCode: string;
  creatorUserId: string;
  treeId?: string | null;
  type: NestType;
  status: "active" | "ended";
  lifecycleState: "created" | "waiting" | "ready" | "active" | "empty" | "expired" | "closed";
  /** Absent from older servers, which have no doors. */
  door?: NestDoor;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
  endedAt?: string | null;
  emptySince?: string | null;
  expiresAt?: string | null;
  lastActivityAt: string;
  shareableLink: string;
  httpLink: string;
}

export interface ParticipantSummary {
  userId: string;
  username: string;
  displayName: string;
  joinedAt: string;
  /** "Back in a bit". Absent on a server that predates the call-state route. */
  away?: boolean;
  deafened?: boolean;
  /** Set by a moderator, and the person can't undo them. Absent on an older server. */
  serverMuted?: boolean;
  serverDeafened?: boolean;
}

export interface CallStatePatch {
  away?: boolean;
  deafened?: boolean;
}

export interface SessionSummary {
  id: string;
  nestId: string;
  startedAt: string;
  endedAt?: string | null;
  durationSeconds?: number | null;
  status: "active" | "ended";
  participants: ParticipantSummary[];
}

export interface LauncherNest extends Nest {
  active: boolean;
  activeParticipantCount: number;
  currentParticipants: ParticipantSummary[];
  currentSessionStartedAt?: string | null;
  currentSessionId?: string | null;
}

export interface NestEvent {
  id: string;
  nestId: string;
  sessionId?: string | null;
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  eventType: string;
  metadata?: unknown;
  createdAt: string;
}

export interface NestHistory {
  sessions: SessionSummary[];
  events: NestEvent[];
}

export interface Invitation {
  id: string;
  nestId: string;
  userId: string;
  username: string;
  displayName: string;
  createdAt: string;
}

export interface JoinRequest {
  id: string;
  nestId: string;
  nestName: string;
  userId: string;
  username: string;
  displayName: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface Member {
  nestId: string;
  userId: string;
  username: string;
  displayName: string;
  role: NestRole;
  state: MembershipState;
  joinedAt?: string | null;
  leftAt?: string | null;
}

export interface Dashboard {
  created: Nest[];
  invited: Nest[];
  joined: Nest[];
  pendingAdmission: JoinRequest[];
}

export interface NestDetails {
  nest: Nest;
  members: Member[];
  invitations: Invitation[];
  joinRequests: JoinRequest[];
}

export interface Tree {
  id: string;
  name: string;
  description: string;
  joinPolicy: TreeJoinPolicy;
  visibility: TreeVisibility;
  creatorUserId: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface TreeMember {
  treeId: string;
  userId: string;
  username: string;
  displayName: string;
  /** The name they chose in this space, empty when they use their usual one. */
  nickname?: string;
  /** Their usual (global) name, for places outside this space. */
  usualName?: string;
  role: TreeRole;
  state: TreeMembershipState;
  joinedAt?: string | null;
  leftAt?: string | null;
  presenceState: UserPresenceState;
  reachability: UserReachability;
  activeNestId?: string | null;
}

export interface TreeJoinRequest {
  id: string;
  treeId: string;
  treeName: string;
  userId: string;
  username: string;
  displayName: string;
  status: "pending" | "accepted" | "rejected" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

export interface TreeSearchResult {
  tree: Tree;
  memberRole?: TreeRole;
  requestId?: string;
  accessState: "none" | "joined" | "pending";
}

export interface UserPresence {
  userId: string;
  username: string;
  displayName: string;
  state: UserPresenceState;
  reachability: UserReachability;
  activeNestId?: string | null;
  updatedAt: string;
}

export interface Knock {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  toUserId?: string | null;
  toUsername?: string | null;
  toDisplayName?: string | null;
  nestId?: string | null;
  nestName?: string | null;
  status: KnockStatus;
  message?: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string | null;
  resolvedByUserId?: string | null;
  reply?: KnockReply | null;
  replyUntil?: string | null;
  replyMessage?: string | null;
}

export interface Friend {
  userId: string;
  username: string;
  displayName: string;
  createdAt: string;
  presenceState: UserPresenceState;
  reachability: UserReachability;
  activeNestId?: string | null;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  toUserId: string;
  toUsername: string;
  toDisplayName: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  createdAt: string;
  resolvedAt?: string | null;
}

/** One house rule of a space. Icon ids come from shells/ravenv1/boardIcons.ts. */
export interface TreeRule {
  id: string;
  icon: string;
  text: string;
  position: number;
}

/** A pinned note on a space's lobby. Title and description may hold mention tokens. */
export interface TreeNote {
  id: string;
  title: string;
  description: string;
  /** ISO time it stops showing, or null for no end. */
  endsAt: string | null;
  position: number;
}

export interface TreeNoteInput {
  title: string;
  description: string;
  endsAt: string | null;
}

/** One sitting of a scheduled event, in UTC. */
export interface TreeEventOccurrence {
  startsAt: string;
  endsAt: string;
}

/** A gathering scheduled in one room of a space. Title and description may hold mention tokens. */
export interface TreeEvent {
  id: string;
  title: string;
  description: string;
  hostUserId: string;
  /** The host's name in this space. */
  hostName: string;
  nestId: string | null;
  conversationId: string | null;
  roomName: string;
  /** The first start of the series. */
  startsAt: string;
  endsAt: string | null;
  durationMinutes: number | null;
  /** RFC 5545 subset, for example "FREQ=WEEKLY;BYDAY=SU". Null for a one-off. */
  rrule: string | null;
  /** The IANA zone the series repeats in. */
  tz: string;
  inviteAll: boolean;
  /** Empty for people who cannot manage the board. */
  inviteeIds: string[];
  sendInviteMessage: boolean;
  pinned: boolean;
  /** The occurrence under way or next. */
  occurrence: TreeEventOccurrence;
}

export interface TreeEventInput {
  title: string;
  description: string;
  hostUserId: string;
  nestId: string | null;
  conversationId: string | null;
  startsAt: string;
  endsAt: string | null;
  durationMinutes: number | null;
  rrule: string | null;
  tz: string;
  inviteAll: boolean;
  inviteeIds: string[];
  sendInviteMessage: boolean;
  pinned: boolean;
}

/** Rides on "event.invited" and "event.reminder", which reach invitees only. */
export interface EventNotice {
  id: string;
  treeId: string;
  title: string;
  space: string;
  room: string;
  host: string;
  startsAt: string;
}

export interface TreeDetails {
  tree: Tree;
  members: TreeMember[];
  activeNests: Nest[];
  inactiveNests: Nest[];
  joinRequests: TreeJoinRequest[];
  rules: TreeRule[];
  /** Absent from older servers. */
  notes?: TreeNote[];
  /** Scheduled events that are not over, pinned first. Absent from older servers. */
  events?: TreeEvent[];
  /** The asker's role here and what it allows, decided by the server. */
  viewer?: { role: TreeRole; permissions: string[] };
  /** The space's sticker settings. Absent from servers without GIFs and stickers. */
  library?: { savedStickersPublishable: boolean };
}

export interface HomeState {
  user: User;
  presence: UserPresence;
  trees: Tree[];
  activeNests: LauncherNest[];
  temporaryNests: LauncherNest[];
  pendingKnocks: Knock[];
  profileKnocks?: ProfileKnockState[];
  pendingInvites: Invitation[];
  pendingRequests: JoinRequest[];
  friends: Friend[];
  incomingFriendRequests: FriendRequest[];
  outgoingFriendRequests: FriendRequest[];
}

export interface LoginResponse {
  user: User;
}

export interface ProfileKnockState {
  knockId?: string;
  userId: string;
  /** The display name of the person knocked on. */
  name?: string;
  /** `replied`: an answer holds until `retryAt`. `reminder`: an Ask me later is due, knocking is allowed. */
  state: "pending" | "cooldown" | "replied" | "reminder";
  outcome: KnockStatus;
  reply?: KnockReply;
  replyUntil?: string;
  /** The note sent with a "message" answer. */
  message?: string;
  expiresAt: string;
  retryAt: string;
}

export interface AuthSession {
  id: string;
  latestIp: string;
  userAgent: string;
  os: string;
  deviceName: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
  revokedAt?: string;
  current: boolean;
}

export interface ServerProperties {
  name: string;
  description: string;
  avatar: string;
  rtcServerUrl: string;
  properties: Record<string, unknown>;
}

export interface ServerCompatibility {
  status: string;
  reasonCode: string;
  message: string;
  clientVersion?: string;
  serverVersion?: string;
  minimumClientVersion?: string;
}

export interface JoinResponse {
  status: "joined" | "waiting";
  nest: Nest;
  joinRequest?: JoinRequest;
}

export interface LiveKitTokenResponse {
  url: string;
  token: string;
  sessionName: string;
  identity: string;
  displayName: string;
}

/** One event from the server's event stream: its name and its data, as text. */
export interface EventStreamFrame {
  event: string;
  data: string;
}

export interface EventStreamHandlers {
  onFrame: (frame: EventStreamFrame) => void;
  /** The stream is established. `reconnected` is false the first time only. */
  onOpen?: (reconnected: boolean) => void;
  /** The connection ended; another attempt follows unless the stream was closed. */
  onClose?: () => void;
  /** The server no longer accepts this session. The stream stops for good. */
  onUnauthorized?: () => void;
}

export interface EventStreamOptions {
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  idleTimeoutMs?: number;
}

/** Splits one server-sent event into its name and data. Comment lines yield null. */
export function parseEventStreamFrame(raw: string): EventStreamFrame | null {
  let event = "";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (!event || data.length === 0) return null;
  return { event, data: data.join("\n") };
}

export function parseNestLiveUpdateEvent(event: string): NestLiveUpdate | null {
  const frame = parseEventStreamFrame(event);
  if (!frame || frame.event !== "nest-update") return null;
  return parseNestLiveUpdateData(frame.data);
}

export function parseNestLiveUpdateData(data: string): NestLiveUpdate | null {
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed.type !== "string" || !parsed.type) return null;
    return {
      type: parsed.type,
      treeId: typeof parsed.treeId === "string" && parsed.treeId ? parsed.treeId : undefined,
      nestId: typeof parsed.nestId === "string" && parsed.nestId ? parsed.nestId : undefined,
      sessionId: typeof parsed.sessionId === "string" && parsed.sessionId ? parsed.sessionId : undefined,
      actorId: typeof parsed.actorId === "string" && parsed.actorId ? parsed.actorId : undefined,
      actorName: typeof parsed.actorName === "string" && parsed.actorName ? parsed.actorName : undefined,
      vote: parseCallVote(parsed.vote),
      share: parsed.share && typeof parsed.share === "object" ? (parsed.share as WorkshopShare) : undefined,
      reason: typeof parsed.reason === "string" && parsed.reason ? parsed.reason : undefined,
      at: typeof parsed.at === "string" && parsed.at ? parsed.at : undefined,
      event: parseEventNotice(parsed.event),
    };
  } catch {
    return null;
  }
}

function parseEventNotice(value: unknown): EventNotice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const notice = value as Record<string, unknown>;
  const text = (key: string) => (typeof notice[key] === "string" ? (notice[key] as string) : "");
  if (!text("id") || !text("title")) return undefined;
  return { id: text("id"), treeId: text("treeId"), title: text("title"), space: text("space"), room: text("room"), host: text("host"), startsAt: text("startsAt") };
}

export class ApiClient {
  private sessionId = localStorage.getItem(SESSION_ID_KEY) ?? "";
  private baseUrl = readStoredApiServerUrl();
  /**
   * Set while the server refuses this version of Raven as too old (HTTP 426). The shell
   * shows its update screen, and requests that would only be refused again are not sent.
   */
  private updateRequired: ServerCompatibility | null = null;

  getBaseUrl() {
    return this.baseUrl;
  }

  url(path: string) {
    return `${this.baseUrl}${path}`;
  }

  assetUrl(value: string) {
    if (!value || /^(?:https?:|data:|blob:)/i.test(value)) return value;
    return this.url(value.startsWith("/") ? value : `/${value}`);
  }

  userAvatarUrl(userId: string, version = "") {
    version = avatarVersion(userId) || version;
    return this.url(`/v1/media/users/${encodeURIComponent(userId)}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`);
  }

  treeAvatarUrl(treeId: string, version = "") {
    return this.url(`/v1/media/trees/${encodeURIComponent(treeId)}/avatar${version ? `?v=${encodeURIComponent(version)}` : ""}`);
  }

  getServerHistory() {
    return readApiServerHistory();
  }

  setBaseUrl(value: string, remember = true) {
    const next = normalizeApiServerUrl(value);
    this.baseUrl = next;
    localStorage.setItem(API_SERVER_URL_KEY, next);
    if (remember) rememberApiServerUrl(next);
    return next;
  }

  setSessionId(sessionId: string) {
    const previous = this.sessionId;
    this.sessionId = sessionId;
    localStorage.setItem(SESSION_ID_KEY, sessionId);
    // The server rotates ids; keep the saved entry for this session valid.
    if (previous && previous !== sessionId) {
      const list = readAccounts(localStorage);
      if (list.some((item) => item.serverUrl === this.baseUrl && item.sessionId === previous)) {
        writeAccounts(localStorage, list.map((item) =>
          item.serverUrl === this.baseUrl && item.sessionId === previous ? { ...item, sessionId } : item));
      }
    }
  }

  clearSession() {
    // Sign out and expiry both end here, so the account leaves the saved list too.
    if (this.sessionId) writeAccounts(localStorage, removeBySession(readAccounts(localStorage), this.baseUrl, this.sessionId));
    this.sessionId = "";
    localStorage.removeItem(SESSION_ID_KEY);
    localStorage.removeItem("raven.token");
  }

  /** Saved sign-ins for the account menu and the sign-in screen, active first. */
  savedAccounts() {
    return sortForMenu(readAccounts(localStorage), this.baseUrl, this.sessionId);
  }

  /** Saves the active sign-in. Signing the same user in again retires the older session. */
  rememberAccount(user: { id: string; username: string; displayName: string }, serverName: string) {
    if (!this.sessionId) return;
    const { list, replacedSessionId } = upsertAccount(readAccounts(localStorage), {
      serverUrl: this.baseUrl,
      sessionId: this.sessionId,
      userId: user.id,
      username: user.username,
      displayName: user.displayName,
      serverName,
      lastUsedAt: Date.now(),
    });
    writeAccounts(localStorage, list);
    if (replacedSessionId) {
      void this.signOutSaved({ serverUrl: this.baseUrl, sessionId: replacedSessionId }).catch(() => undefined);
    }
  }

  /** Makes a saved account the active one. The caller reloads the page. */
  activateAccount(account: SavedAccount) {
    localStorage.setItem(API_SERVER_URL_KEY, account.serverUrl);
    localStorage.setItem(SESSION_ID_KEY, account.sessionId);
    writeAccounts(localStorage, readAccounts(localStorage).map((item) =>
      item.serverUrl === account.serverUrl && item.sessionId === account.sessionId
        ? { ...item, lastUsedAt: Date.now() }
        : item));
  }

  /** Leaves the sign-in screen next; the current account stays saved. The caller reloads. */
  beginAddAccount() {
    localStorage.removeItem(SESSION_ID_KEY);
  }

  /** Ends a saved session on its own server (best effort) and forgets it. */
  async signOutSaved(account: Pick<SavedAccount, "serverUrl" | "sessionId">) {
    try {
      const headers = new Headers({ Accept: "application/json", "X-Session-ID": account.sessionId });
      headers.set("X-Raven-OS", desktopOS());
      headers.set("X-Raven-Device", "Raven Desktop");
      addClientCompatibilityHeaders(headers);
      await fetch(`${account.serverUrl}/v1/auth/logout`, { method: "POST", headers });
    } catch {
      // The server may be unreachable; the saved entry goes either way.
    }
    writeAccounts(localStorage, removeBySession(readAccounts(localStorage), account.serverUrl, account.sessionId));
  }

  getSessionId() {
    return this.sessionId;
  }

  getUpdateRequired() {
    return this.updateRequired;
  }

  private setUpdateRequired(required: ServerCompatibility | null) {
    if (this.updateRequired === required) return;
    this.updateRequired = required;
    updateRequiredListeners.forEach((listener) => listener(required));
  }

  /** Asks the server whether it still accepts this version, and records the answer. */
  async checkCompatibility() {
    const query = new URLSearchParams({ clientVersion: RAVEN_CLIENT_VERSION });
    const { compatibility } = await this.request<{ compatibility: ServerCompatibility }>(
      `/v1/server/compatibility?${query}`,
      { auth: false },
    );
    this.setUpdateRequired(compatibility.status === "compatible" ? null : compatibility);
    return compatibility;
  }

  async login(username: string, password: string) {
    const response = await this.request<LoginResponse>("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      auth: false,
    });
    rememberApiServerUrl(this.baseUrl);
    return response;
  }

  async signUp(request: SignUpRequest) {
    const response = await this.request<LoginResponse>("/v1/auth/sign-up", {
      method: "POST",
      body: JSON.stringify(request),
      auth: false,
    });
    rememberApiServerUrl(this.baseUrl);
    return response;
  }

  listInvites() {
    return this.request<{ invites: Invite[] }>("/v1/invites");
  }

  createInvite() {
    return this.request<{ invite: Invite; code: string }>("/v1/invites", { method: "POST" });
  }

  revokeInvite(id: string) {
    return this.request<void>(`/v1/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  logout() {
    return this.request<void>("/v1/auth/logout", { method: "POST" });
  }

  accountDeletion() {
    return this.request<AccountDeletionState>("/v1/account/deletion");
  }

  /** A .zip of everything the person can see. Throws an ApiError with `retryAfterSeconds` when they asked too often. */
  async exportAccount(): Promise<ArrayBuffer> {
    const blob = await this.request<Blob>("/v1/account/export", { response: "blob" });
    return blob.arrayBuffer();
  }

  deleteAccount(input: { password: string; confirmUsername: string; messages: "erase" | "keep" }) {
    return this.request<void>("/v1/account/delete", { method: "POST", body: JSON.stringify(input) });
  }

  authSessions() {
    return this.request<{ sessions: AuthSession[] }>("/v1/auth/sessions");
  }

  revokeAuthSession(id: string) {
    return this.request<{ revoked: boolean; current: boolean }>(`/v1/auth/sessions/${id}`, { method: "DELETE" });
  }

  subscribeNestEvents(onUpdate: (update: NestLiveUpdate) => void, options: EventStreamOptions = {}) {
    return this.openEventStream(
      {
        onOpen: (reconnected) => {
          if (reconnected) onUpdate({ type: "stream.reconnected", at: new Date().toISOString() });
        },
        onFrame: (frame) => {
          if (frame.event !== "nest-update") return;
          const update = parseNestLiveUpdateData(frame.data);
          if (update) onUpdate(update);
        },
      },
      options,
    );
  }

  /**
   * Opens the server's event stream and keeps it open, reconnecting when it drops.
   * Every kind of live update arrives here; callers pick the events they understand by
   * name. Returns the function that closes it.
   */
  openEventStream(handlers: EventStreamHandlers, options: EventStreamOptions = {}) {
    if (this.updateRequired) return () => undefined;
    const controller = new AbortController();
    const initialReconnectDelayMs = Math.max(options.initialReconnectDelayMs ?? 1000, 0);
    const maxReconnectDelayMs = Math.max(options.maxReconnectDelayMs ?? 30_000, initialReconnectDelayMs);
    // The server sends a keepalive comment every 15 s. A stream that stays silent for
    // three intervals is dead even if the socket has not noticed; reconnect.
    const idleTimeoutMs = Math.max(options.idleTimeoutMs ?? 45_000, 0);
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let hasConnected = false;
    let connectedThisAttempt = false;
    let unauthorized = false;

    const waitForReconnect = (delayMs: number) => new Promise<void>((resolve) => {
      if (controller.signal.aborted || delayMs === 0) {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timeout = setTimeout(finish, delayMs);
      controller.signal.addEventListener("abort", finish, { once: true });
    });

    const consumeStream = async () => {
      const headers = new Headers({ Accept: "text/event-stream" });
      if (this.sessionId) headers.set("X-Session-ID", this.sessionId);
      headers.set("X-Raven-OS", desktopOS());
      headers.set("X-Raven-Device", "Raven Desktop");
      addClientCompatibilityHeaders(headers);
      const response = await fetch(this.url("/v1/nest-events"), { headers, signal: controller.signal });
      if (response.status === 401) {
        // Retrying cannot help: the session is gone until the person signs in again.
        unauthorized = true;
        return;
      }
      if (!response.ok || !response.body) return;
      const reconnected = hasConnected;
      hasConnected = true;
      connectedThisAttempt = true;
      handlers.onOpen?.(reconnected);
      const nextSessionId = response.headers.get("X-Session-ID");
      if (nextSessionId) this.setSessionId(nextSessionId);
      const reader = response.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      let lastActivityAt = Date.now();
      const watchdog = idleTimeoutMs > 0
        ? setInterval(() => {
            if (Date.now() - lastActivityAt > idleTimeoutMs) void reader.cancel().catch(() => undefined);
          }, Math.min(5000, Math.max(250, idleTimeoutMs / 3)))
        : null;
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          lastActivityAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 262_144) buffer = "";
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            const frame = parseEventStreamFrame(event);
            if (frame) handlers.onFrame(frame);
          }
        }
      } finally {
        if (watchdog !== null) clearInterval(watchdog);
        if (activeReader === reader) activeReader = null;
        reader.releaseLock();
        if (!controller.signal.aborted) handlers.onClose?.();
      }
    };

    const run = async () => {
      let reconnectDelayMs = initialReconnectDelayMs;
      while (!controller.signal.aborted) {
        connectedThisAttempt = false;
        try {
          await consumeStream();
        } catch {
          // A dropped stream is expected during server/network changes. Reconnect below.
        }
        if (controller.signal.aborted) break;
        if (unauthorized) {
          handlers.onUnauthorized?.();
          break;
        }
        // Back off only across consecutive failures; a stream that did connect and later
        // dropped is retried promptly.
        if (connectedThisAttempt) reconnectDelayMs = initialReconnectDelayMs;
        // Spread reconnects out: when the server restarts, every client loses its stream
        // in the same instant and would otherwise all come back in the same instant too.
        await waitForReconnect(reconnectDelayMs * (0.5 + Math.random()));
        reconnectDelayMs = Math.min(Math.max(reconnectDelayMs * 2, 1), maxReconnectDelayMs);
      }
    };

    void run();
    return () => {
      controller.abort();
      void activeReader?.cancel().catch(() => undefined);
      activeReader = null;
    };
  }

  serverProperties() {
    return this.request<ServerProperties>("/v1/server/properties", { auth: false });
  }

  fallbackServerProperties(): ServerProperties {
    return {
      name: "Raven",
      description: "Desktop RTC for private Nests",
      avatar: "",
      rtcServerUrl: "ws://127.0.0.1:7880",
      properties: {},
    };
  }

  me() {
    return this.request<{ user: User }>("/v1/auth/me");
  }

  preferences() {
    return this.request<{ preferences: UserPreferences }>("/v1/preferences");
  }

  updatePreferences(patch: Partial<Pick<UserPreferences, "displayName" | "uiLabels" | "colorPalette" | "alwaysJoinMuted" | "joinWithCameraOff" | "joinWithoutScreenSharing" | "followScreenShares" | "watchNewShares" | "ravenMessages">>) {
    return this.request<{ preferences: UserPreferences; user: User }>("/v1/preferences", {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  uploadProfileAvatar(file: File) {
    return this.uploadAvatar("/v1/profile/avatar", file).then((result) => {
      noteAvatarRoute(result.avatar);
      return result;
    });
  }

  dashboard() {
    return this.request<Dashboard>("/v1/nests");
  }

  home() {
    return this.request<HomeState>("/v1/home");
  }

  trees() {
    return this.request<{ trees: Tree[] }>("/v1/trees");
  }

  searchTrees(query: string) {
    return this.request<{ trees: TreeSearchResult[] }>(`/v1/trees/search?q=${encodeURIComponent(query)}`);
  }

  searchUsers(query: string) {
    return this.request<{ users: PublicUser[] }>(`/v1/users/search?q=${encodeURIComponent(query)}`);
  }

  friends() {
    return this.request<{ friends: Friend[]; incomingFriendRequests: FriendRequest[]; outgoingFriendRequests: FriendRequest[] }>("/v1/friends");
  }

  createFriendRequest(payload: { toUserId?: string; username?: string }) {
    return this.request<{ friendRequest: FriendRequest }>("/v1/friend-requests", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  acceptFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/accept`, { method: "POST" });
  }

  declineFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/decline`, { method: "POST" });
  }

  cancelFriendRequest(id: string) {
    return this.request<{ friendRequest: FriendRequest }>(`/v1/friend-requests/${id}/cancel`, { method: "POST" });
  }

  removeFriend(userId: string) {
    return this.request<void>(`/v1/friends/${userId}`, { method: "DELETE" });
  }

  createTree(payload: { name: string; description?: string; joinPolicy?: TreeJoinPolicy; visibility?: TreeVisibility }) {
    return this.request<{ tree: Tree }>("/v1/trees", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  getTree(id: string) {
    return this.request<TreeDetails>(`/v1/trees/${id}`);
  }

  updateTreeSettings(treeId: string, payload: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility; savedStickersPublishable?: boolean }) {
    return this.request<{ tree: Tree }>(`/v1/trees/${treeId}/settings`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  createTreeRule(treeId: string, payload: { icon: string; text: string }) {
    return this.request<{ rule: TreeRule }>(`/v1/trees/${treeId}/rules`, { method: "POST", body: JSON.stringify(payload) });
  }

  editTreeRule(treeId: string, ruleId: string, payload: { icon: string; text: string }) {
    return this.request<{ rule: TreeRule }>(`/v1/trees/${treeId}/rules/${ruleId}`, { method: "POST", body: JSON.stringify(payload) });
  }

  deleteTreeRule(treeId: string, ruleId: string) {
    return this.request<void>(`/v1/trees/${treeId}/rules/${ruleId}`, { method: "DELETE" });
  }

  orderTreeRules(treeId: string, ids: string[]) {
    return this.request<{ rules: TreeRule[] }>(`/v1/trees/${treeId}/rules/order`, { method: "POST", body: JSON.stringify({ ids }) });
  }

  createTreeNote(treeId: string, payload: TreeNoteInput) {
    return this.request<{ note: TreeNote }>(`/v1/trees/${treeId}/notes`, { method: "POST", body: JSON.stringify(payload) });
  }

  editTreeNote(treeId: string, noteId: string, payload: TreeNoteInput) {
    return this.request<{ note: TreeNote }>(`/v1/trees/${treeId}/notes/${noteId}`, { method: "POST", body: JSON.stringify(payload) });
  }

  deleteTreeNote(treeId: string, noteId: string) {
    return this.request<void>(`/v1/trees/${treeId}/notes/${noteId}`, { method: "DELETE" });
  }

  orderTreeNotes(treeId: string, ids: string[]) {
    return this.request<{ notes: TreeNote[] }>(`/v1/trees/${treeId}/notes/order`, { method: "POST", body: JSON.stringify({ ids }) });
  }

  createTreeEvent(treeId: string, payload: TreeEventInput) {
    return this.request<{ event: TreeEvent }>(`/v1/trees/${treeId}/events`, { method: "POST", body: JSON.stringify(payload) });
  }

  editTreeEvent(treeId: string, eventId: string, payload: TreeEventInput) {
    return this.request<{ event: TreeEvent }>(`/v1/trees/${treeId}/events/${eventId}`, { method: "POST", body: JSON.stringify(payload) });
  }

  deleteTreeEvent(treeId: string, eventId: string) {
    return this.request<void>(`/v1/trees/${treeId}/events/${eventId}`, { method: "DELETE" });
  }

  pinTreeEvent(treeId: string, eventId: string, pinned: boolean) {
    return this.request<void>(`/v1/trees/${treeId}/events/${eventId}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
  }

  uploadTreeAvatar(treeId: string, file: File) {
    return this.uploadAvatar(`/v1/trees/${treeId}/avatar`, file);
  }

  deleteTree(treeId: string, confirmation: string) {
    return this.request<void>(`/v1/trees/${treeId}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation }),
    });
  }

  joinTree(treeId: string) {
    return this.request<{ status: "joined" | "waiting"; tree: Tree; member?: TreeMember; joinRequest?: TreeJoinRequest }>(`/v1/trees/${treeId}/join`, {
      method: "POST",
    });
  }

  /** Leaves a tree. The owner cannot: ownership is transferred first. */
  leaveTree(treeId: string) {
    return this.request<void>(`/v1/trees/${treeId}/leave`, { method: "POST" });
  }

  /** Hands the tree to another member. The caller stays, as a moderator. */
  transferTreeOwnership(treeId: string, userId: string) {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    });
  }

  addTreeMember(treeId: string, username: string, role: TreeRole = "member") {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/members`, {
      method: "POST",
      body: JSON.stringify({ username, role }),
    });
  }

  updateTreeMemberRole(treeId: string, userId: string, role: TreeRole) {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/members/${userId}/role`, {
      method: "POST",
      body: JSON.stringify({ role }),
    });
  }

  updateTreeMemberName(treeId: string, userId: string, displayName: string) {
    return this.request<{ member: TreeMember }>(`/v1/trees/${treeId}/members/${userId}/name`, {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  }

  removeTreeMember(treeId: string, userId: string) {
    return this.request<void>(`/v1/trees/${treeId}/members/${userId}`, { method: "DELETE" });
  }

  acceptTreeJoinRequest(treeId: string, requestId: string) {
    return this.request<{ joinRequest: TreeJoinRequest; status: "accepted" }>(`/v1/trees/${treeId}/join-requests/${requestId}/accept`, { method: "POST" });
  }

  rejectTreeJoinRequest(treeId: string, requestId: string) {
    return this.request<{ joinRequest: TreeJoinRequest; status: "rejected" }>(`/v1/trees/${treeId}/join-requests/${requestId}/reject`, { method: "POST" });
  }

  createNest(name: string, type: NestType = "persistent") {
    return this.request<{ nest: Nest }>("/v1/nests", {
      method: "POST",
      body: JSON.stringify({ name, type }),
    });
  }

  createPersistentNest(name: string) {
    return this.request<{ nest: Nest }>("/v1/nests/persistent", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  createTemporaryNest(name: string) {
    return this.request<{ nest: Nest }>("/v1/nests/temporary", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  createTreeNest(treeId: string, name: string, door?: NestDoor) {
    return this.request<{ nest: Nest }>(`/v1/trees/${treeId}/nests`, {
      method: "POST",
      body: JSON.stringify({ name, ...(door ? { door } : {}) }),
    });
  }

  launcherNests() {
    return this.request<{ nests: LauncherNest[] }>("/v1/nests/launcher");
  }

  getNest(id: string) {
    return this.request<NestDetails>(`/v1/nests/${id}`);
  }

  inviteUser(nestId: string, username: string) {
    return this.request<{ invitation: Invitation }>(`/v1/nests/${nestId}/invitations`, {
      method: "POST",
      body: JSON.stringify({ username }),
    });
  }

  joinNest(nestId: string) {
    return this.request<JoinResponse>(`/v1/nests/${nestId}/join`, { method: "POST" });
  }

  joinByCode(value: string) {
    return this.request<JoinResponse>("/v1/nests/join-by-code", {
      method: "POST",
      body: JSON.stringify({ code: value, link: value }),
    });
  }

  leaveNest(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/leave`, { method: "POST" });
  }

  archiveNest(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/archive`, { method: "POST" });
  }

  updateNestSettings(nestId: string, settings: { name?: string; door?: NestDoor }) {
    return this.request<{ nest: Nest }>(`/v1/nests/${nestId}/settings`, {
      method: "POST",
      body: JSON.stringify(settings),
    });
  }

  renameNest(nestId: string, name: string) {
    return this.request<{ nest: Nest }>(`/v1/nests/${nestId}/settings`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  joinNestPresence(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/presence/join`, { method: "POST" });
  }

  leaveNestPresence(nestId: string) {
    return this.request<void>(`/v1/nests/${nestId}/presence/leave`, { method: "POST" });
  }

  joinSession(nestId: string) {
    return this.request<{ session: SessionSummary }>(`/v1/nests/${nestId}/session/join`, { method: "POST" });
  }

  workshopConfig() {
    return this.request<WorkshopConfig>("/v1/workshop/config");
  }

  workshopShares(placeKind: WorkshopPlaceKind, placeId: string) {
    return this.request<{ shares: WorkshopShare[] }>(`/v1/workshop/places/${placeKind}/${placeId}/shares`);
  }

  createWorkshopShare(body: {
    placeKind: WorkshopPlaceKind;
    placeId: string;
    name: string;
    protocol: WorkshopProtocol;
    port: number;
    audience: "all" | string[];
    minutes: number;
  }) {
    return this.request<{ share: WorkshopShare }>("/v1/workshop/shares", { method: "POST", body: JSON.stringify(body) });
  }

  extendWorkshopShare(shareId: string, minutes: number) {
    return this.request<{ share: WorkshopShare }>(`/v1/workshop/shares/${shareId}/extend`, { method: "POST", body: JSON.stringify({ minutes }) });
  }

  deleteWorkshopShare(shareId: string) {
    return this.request<void>(`/v1/workshop/shares/${shareId}`, { method: "DELETE" });
  }

  currentCallVote(nestId: string) {
    return this.request<{ vote: CallVote | null }>(`/v1/nests/${nestId}/votes/current`);
  }

  startCallVote(nestId: string, targetUserId: string) {
    return this.request<{ vote: CallVote }>(`/v1/nests/${nestId}/votes`, {
      method: "POST",
      body: JSON.stringify({ targetUserId }),
    });
  }

  castCallVoteBallot(nestId: string, voteId: string, yes: boolean) {
    return this.request<{ vote: CallVote }>(`/v1/nests/${nestId}/votes/${voteId}/ballot`, {
      method: "POST",
      body: JSON.stringify({ yes }),
    });
  }

  setCallState(nestId: string, patch: CallStatePatch) {
    return this.request<{ session: SessionSummary }>(`/v1/nests/${nestId}/session/state`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  moderateVoice(nestId: string, userId: string, patch: { muted?: boolean; deafened?: boolean }) {
    return this.request<{ serverMuted: boolean; serverDeafened: boolean }>(`/v1/nests/${nestId}/participants/${userId}/voice`, {
      method: "POST",
      body: JSON.stringify(patch),
    });
  }

  leaveSession(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session/leave`, { method: "POST" });
  }

  disconnectFromNest(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session/disconnect`, { method: "POST" });
  }

  /** Tell the people inside a Nest that you are about to enter. Returns how long to wait. */
  announceNestEntry(nestId: string) {
    return this.request<{ notified: number; delaySeconds: number }>(`/v1/nests/${nestId}/entry-notice`, { method: "POST" });
  }

  /** Withdraw a pending entry announcement. */
  cancelNestEntry(nestId: string) {
    return this.request<{ notified: number; delaySeconds: number }>(`/v1/nests/${nestId}/entry-notice`, { method: "DELETE" });
  }

  activeSession(nestId: string) {
    return this.request<{ session: SessionSummary | null }>(`/v1/nests/${nestId}/session`);
  }

  nestHistory(nestId: string) {
    return this.request<NestHistory>(`/v1/nests/${nestId}/history`);
  }

  liveKitToken(nestId: string, identity?: "audio" | "video") {
    const query = identity ? `?identity=${identity}` : "";
    return this.request<LiveKitTokenResponse>(`/v1/nests/${nestId}/livekit-token${query}`, {
      method: "POST",
    });
  }

  acceptJoinRequest(nestId: string, requestId: string) {
    return this.request(`/v1/nests/${nestId}/join-requests/${requestId}/accept`, { method: "POST" });
  }

  rejectJoinRequest(nestId: string, requestId: string) {
    return this.request(`/v1/nests/${nestId}/join-requests/${requestId}/reject`, { method: "POST" });
  }

  updatePresence(state: UserPresenceState, reachability?: UserReachability, activeNestId?: string | null) {
    return this.request<{ presence: UserPresence }>("/v1/presence", {
      method: "POST",
      body: JSON.stringify({ state, reachability, activeNestId }),
    });
  }

  /**
   * Keep this account online. While in a Nest, pass its id: the server then also reports
   * `nestActive`, which turns false if it timed this client out of the Nest.
   */
  presenceHeartbeat(signal?: AbortSignal, nestHeartbeat = true, nestId?: string) {
    return this.request<{ presence: UserPresence; nestActive?: boolean }>("/v1/presence/heartbeat", {
      method: "POST",
      body: JSON.stringify(nestId ? { nestHeartbeat, nestId } : { nestHeartbeat }),
      signal,
    });
  }

  /** Go offline for everyone right away (the app is closing or signing out). */
  presenceGoodbye() {
    return this.request<void>("/v1/presence/goodbye", { method: "POST", keepalive: true });
  }

  createKnock(payload: { toUserId?: string; username?: string; nestId?: string; message?: string }) {
    return this.request<{ knock: Knock; profileKnock?: ProfileKnockState }>("/v1/knocks", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  listKnocks() {
    return this.request<{ knocks: Knock[] }>("/v1/knocks");
  }

  acceptKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/accept`, { method: "POST" });
  }

  declineKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/decline`, { method: "POST" });
  }

  dismissKnock(id: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/dismiss`, { method: "POST" });
  }

  replyToKnock(id: string, reply: KnockReply, until?: string, message?: string) {
    return this.request<{ knock: Knock }>(`/v1/knocks/${id}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply, ...(until ? { until } : {}), ...(message ? { message } : {}) }),
    });
  }

  /** Replaces the caller's password. Their other devices are signed out. */
  changePassword(currentPassword: string, newPassword: string) {
    return this.request<{ user: User }>("/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  private uploadAvatar(path: string, file: File) {
    if (file.size > 512 * 1024) {
      return Promise.reject(new Error("Profile images must be 512 KB or smaller"));
    }
    return this.request<{ avatar: string }>(path, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
  }

  /**
   * Makes a request the way every endpoint method here does (session, compatibility
   * headers, error mapping). It lets a feature keep its endpoints in its own module:
   * text chat's are in `lib/chat/chatApi.ts`.
   */
  call<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.request<T>(path, init);
  }

  /** Like `call`, for an endpoint that answers with bytes rather than JSON. */
  callBlob(path: string, init: RequestInit = {}): Promise<Blob> {
    return this.request<Blob>(path, { ...init, response: "blob" });
  }

  private async request<T>(
    path: string,
    init: RequestInit & { auth?: boolean; response?: "json" | "none" | "blob" } = {},
  ): Promise<T> {
    if (this.updateRequired && isCompatibilityGatedPath(path)) {
      throw new ApiError(this.updateRequired.message, 426, this.updateRequired.reasonCode, this.updateRequired);
    }
    const { auth = true, response: responseMode = "json", ...requestInit } = init;
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type") && typeof init.body === "string") headers.set("Content-Type", "application/json");
    if (auth && this.sessionId) headers.set("X-Session-ID", this.sessionId);
    headers.set("X-Raven-OS", desktopOS());
    headers.set("X-Raven-Device", "Raven Desktop");
    addClientCompatibilityHeaders(headers);

    const response = await fetch(this.url(path), { ...requestInit, headers });
    const nextSessionId = response.headers.get("X-Session-ID");
    if (nextSessionId) this.setSessionId(nextSessionId);
    if (response.status === 204) return undefined as T;
    if (response.ok && responseMode === "none") {
      await response.body?.cancel().catch(() => undefined);
      return undefined as T;
    }
    if (response.ok && responseMode === "blob") return (await response.blob()) as T;
    const payload: Record<string, unknown> = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = apiErrorFromPayload(payload, response.status);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
      if (response.status === 426 && error.compatibility) this.setUpdateRequired(error.compatibility);
      throw error;
    }
    return payload as T;
  }
}

export function apiErrorFromPayload(payload: Record<string, unknown>, status: number) {
  const compatibility = isServerCompatibility(payload.compatibility) ? payload.compatibility : undefined;
  const message = typeof payload.error === "string"
    ? payload.error
    : compatibility?.message || `Request failed with ${status}`;
  const reasonCode = typeof payload.reasonCode === "string"
    ? payload.reasonCode
    : compatibility?.reasonCode ?? "";
  return new ApiError(
    message,
    status,
    reasonCode,
    compatibility,
    typeof payload.serviceAccess === "string" ? payload.serviceAccess : "",
    payload,
  );
}

function isServerCompatibility(value: unknown): value is ServerCompatibility {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ServerCompatibility>;
  return typeof candidate.status === "string"
    && typeof candidate.reasonCode === "string"
    && typeof candidate.message === "string";
}

function addClientCompatibilityHeaders(headers: Headers) {
  headers.set("X-Raven-Client-Version", RAVEN_CLIENT_VERSION);
  headers.set("X-Raven-Capabilities", RAVEN_CLIENT_CAPABILITIES.join(","));
}

function isCompatibilityGatedPath(path: string) {
  return [
    "/v1/home",
    "/v1/users",
    "/v1/friends",
    "/v1/friend-requests",
    "/v1/trees",
    "/v1/nests",
    "/v1/presence",
    "/v1/knocks",
    "/v1/nest-events",
    "/v1/chat",
  ].some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));
}

function desktopOS() {
  const platform = navigator.platform || navigator.userAgent;
  if (/win/i.test(platform)) return "Windows";
  if (/mac/i.test(platform)) return "macOS";
  if (/linux/i.test(platform)) return "Linux";
  return platform || "Unknown";
}

export const api = new ApiClient();

export { normalizeApiServerUrl };

function readStoredApiServerUrl() {
  const stored = localStorage.getItem(API_SERVER_URL_KEY);
  try {
    return stored ? normalizeApiServerUrl(stored) : DEFAULT_API_BASE_URL;
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}

function readApiServerHistory() {
  const raw = localStorage.getItem(API_SERVER_HISTORY_KEY);
  if (!raw) return [readStoredApiServerUrl()];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [readStoredApiServerUrl()];
    const urls = parsed.flatMap((value) => {
      if (typeof value !== "string") return [];
      try {
        return [normalizeApiServerUrl(value)];
      } catch {
        return [];
      }
    });
    return [...new Set([readStoredApiServerUrl(), ...urls])].slice(0, 8);
  } catch {
    return [readStoredApiServerUrl()];
  }
}

function rememberApiServerUrl(value: string) {
  const url = normalizeApiServerUrl(value);
  const next = [...new Set([url, ...readApiServerHistory()])].slice(0, 8);
  localStorage.setItem(API_SERVER_HISTORY_KEY, JSON.stringify(next));
}
