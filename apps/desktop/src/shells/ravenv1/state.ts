import type { SavedAccount } from "@/lib/accounts";
import type {
  SignUpRequest,
  HomeState,
  JoinRequest,
  Knock,
  LauncherNest,
  Member,
  Nest,
  NestDetails,
  SessionSummary,
  Tree,
  TreeDetails,
  TreeJoinPolicy,
  TreeSearchResult,
  TreeVisibility,
  TreeMember,
  TreeRole,
  User,
  UserPresence,
  Friend,
  FriendRequest,
  PublicUser,
  ServerProperties,
  UILabelPreference,
  UserPreferences,
  UserPresenceState,
  UserReachability,
  KnockReply,
  NestDoor,
} from "@/lib/api";

export type Presence = "open" | "around" | "focused" | "dnd" | "invisible" | "offline";
export type SelectablePresence = Exclude<Presence, "offline">;

// Presence hues. Shape carries the state too (see PresenceDot), so these never
// have to be told apart by colour alone.
export const PRESENCE: Record<Presence, { label: string; h: string }> = {
  open: { label: "Open to talk", h: "146 40% 58%" },
  around: { label: "Around", h: "214 52% 70%" },
  focused: { label: "Focused", h: "38 80% 62%" },
  dnd: { label: "Do not disturb", h: "4 66% 64%" },
  invisible: { label: "Invisible", h: "34 6% 52%" },
  offline: { label: "Offline", h: "34 6% 52%" },
};

export const SELECTABLE_PRESENCES: SelectablePresence[] = ["open", "around", "focused", "dnd", "invisible"];

export type RavenView =
  | { kind: "home" }
  | { kind: "tree"; id: string }
  | { kind: "tree-preview"; result: TreeSearchResult }
  | { kind: "tree-settings"; id: string; section?: string }
  | { kind: "user"; id: string; person?: ShellPerson }
  | { kind: "waiting"; id: string }
  | { kind: "nest"; id: string }
  /** One conversation: a direct message, a group, or a text nest. */
  /** `at` is the seq of a message to open at. */
  | { kind: "chat"; id: string; at?: number }
  /** Every direct message and group, including archived ones. */
  | { kind: "messages" }
  | { kind: "mixer" }
  /** The open-source projects Raven is built on, opened from Settings › About. */
  | { kind: "licences" }
  | { kind: "settings"; section?: string };

export interface ShellPerson {
  id: string;
  name: string;
  /** Their handle, when this client has been told it. */
  username?: string;
  presence: Presence;
  /**
   * Nothing tells this client where the person is (a search result, or someone known
   * only through a friend request). `presence` is then a placeholder and must not be shown.
   */
  presenceUnknown?: boolean;
  treeIds: string[];
  activeNestIds: string[];
  relationship: "friend" | "context";
}

export interface UILabelCopy {
  treeSingular: string;
  treePlural: string;
  nestSingular: string;
  nestPlural: string;
  activeTrees: string;
  liveNests: string;
  temporaryNest: string;
  noTree: string;
}

export type PendingItem =
  | { id: string; kind: "knock"; from: string; fromId: string; context: string; knock: Knock }
  | { id: string; kind: "invite"; from: string; nestId: string; context: string }
  | { id: string; kind: "request"; from: string; fromId: string; nestId: string; context: string; request: JoinRequest }
  | { id: string; kind: "friend"; from: string; fromId: string; context: string; request: FriendRequest }
  /** Someone answered a knock you sent. `key` changes when the answer becomes a reminder. */
  | { id: string; kind: "answer"; from: string; fromId: string; context: string; key: string; reminder: boolean };

/** Someone announced they are about to enter a Nest this client is inside. */
export interface NestEntryNotice {
  nestId: string;
  actorId: string;
  actorName: string;
  receivedAt: number;
}

export interface RavenShellData {
  user: User | null;
  preferences: UserPreferences;
  labels: UILabelCopy;
  serverProperties: ServerProperties;
  apiServerUrl: string;
  apiServerHistory: string[];
  /** Saved sign-ins, active first. Only the active one is connected. */
  savedAccounts: SavedAccount[];
  home: HomeState | null;
  presence: UserPresence | null;
  trees: Tree[];
  treeDetails: Record<string, TreeDetails>;
  nestDetails: Record<string, NestDetails>;
  activeSessions: Record<string, SessionSummary | null>;
  activeNests: LauncherNest[];
  temporaryNests: LauncherNest[];
  friends: Friend[];
  incomingFriendRequests: FriendRequest[];
  outgoingFriendRequests: FriendRequest[];
  people: ShellPerson[];
  pending: PendingItem[];
  entryNotices: NestEntryNotice[];
  loading: boolean;
  busy: boolean;
  error: string;
  /** Something to tell the person on the sign-in screen that is not a failure. */
  notice: string;
  serverUnreachable: boolean;
  login: (username: string, password: string) => Promise<void>;
  signUp: (request: SignUpRequest) => Promise<void>;
  logout: () => void;
  /** The server deleted this account: forget it and explain on the sign-in screen. */
  accountDeleted: (host: string) => void;
  /** Make a saved account the active one and reload the page. */
  switchAccount: (account: SavedAccount) => void;
  /** Go to the sign-in screen with the current account kept, and reload. */
  addAccount: () => void;
  /** Sign a saved account out on its server and drop it from the list. */
  forgetAccount: (account: SavedAccount) => Promise<void>;
  /** The server no longer accepts this session: return to sign-in and say why. */
  sessionExpired: () => void;
  selectApiServer: (url: string) => Promise<void>;
  refresh: () => Promise<void>;
  retryConnection: () => Promise<void>;
  updatePreferences: (patch: Partial<Pick<UserPreferences, "displayName" | "uiLabels" | "colorPalette" | "alwaysJoinMuted" | "joinWithCameraOff" | "joinWithoutScreenSharing" | "followScreenShares" | "watchNewShares" | "ravenMessages">>) => Promise<void>;
  getTree: (id: string) => Tree | undefined;
  getNest: (id: string) => Nest | LauncherNest | undefined;
  getPerson: (id: string) => ShellPerson | undefined;
  getTreeDetails: (id: string) => TreeDetails | undefined;
  getNestDetails: (id: string) => NestDetails | undefined;
  getActiveSession: (id: string) => SessionSummary | null | undefined;
  searchUsers: (query: string) => Promise<PublicUser[]>;
  searchTrees: (query: string) => Promise<TreeSearchResult[]>;
  createTree: (name: string) => Promise<Tree>;
  updateTreeSettings: (treeId: string, settings: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility; savedStickersPublishable?: boolean }) => Promise<Tree>;
  deleteTree: (treeId: string, confirmation: string) => Promise<void>;
  joinTree: (treeId: string) => Promise<"joined" | "waiting">;
  createTreeNest: (treeId: string, name: string, door?: NestDoor) => Promise<Nest>;
  renameNest: (nestId: string, name: string) => Promise<void>;
  updateNestSettings: (nestId: string, settings: { name?: string; door?: NestDoor }) => Promise<void>;
  letInKnock: (knockId: string) => Promise<void>;
  declineRoomKnock: (knockId: string) => Promise<void>;
  /** Ends a voice nest for everyone in it. The caller leaves the call first if it is in it. */
  deleteNest: (nestId: string) => Promise<void>;
  addTreeMember: (treeId: string, username: string, role?: TreeRole) => Promise<TreeMember>;
  updateTreeMemberRole: (treeId: string, userId: string, role: TreeRole) => Promise<TreeMember>;
  updateTreeMemberName: (treeId: string, userId: string, displayName: string) => Promise<TreeMember>;
  removeTreeMember: (treeId: string, userId: string) => Promise<void>;
  leaveTree: (treeId: string) => Promise<void>;
  transferTreeOwnership: (treeId: string, userId: string) => Promise<TreeMember>;
  /** The account holds a temporary password and can do nothing until it is replaced. */
  passwordChangeRequired: boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  acceptTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  rejectTreeJoinRequest: (treeId: string, requestId: string) => Promise<void>;
  sendFriendRequest: (userId: string) => Promise<void>;
  acceptFriendRequest: (requestId: string) => Promise<void>;
  declineFriendRequest: (requestId: string) => Promise<void>;
  cancelFriendRequest: (requestId: string) => Promise<void>;
  removeFriend: (userId: string) => Promise<void>;
  setPresence: (presence: SelectablePresence) => Promise<void>;
  joinNest: (nestId: string) => Promise<"joined" | "waiting">;
  knockUser: (userId: string) => Promise<void>;
  dismissKnock: (knockId: string) => Promise<void>;
  /** Answer a knock on you. `until` is the time picked for Ask me later or a message's hold; `message` is its note. */
  replyToKnock: (knockId: string, reply: KnockReply, until?: Date, message?: string) => Promise<void>;
  /** Hide an answer to your knock on this device. */
  clearKnockAnswer: (key: string) => void;
}

export function defaultPreferences(username = "You"): UserPreferences {
  return {
    displayName: username,
    uiLabels: "tree_nest",
    colorPalette: "raven_dark",
    colorPaletteEnabled: false,
    alwaysJoinMuted: false,
    joinWithCameraOff: false,
    joinWithoutScreenSharing: false,
    followScreenShares: true,
    watchNewShares: false,
    updatedAt: "",
  };
}

export function labelsForPreference(mode: UILabelPreference = "tree_nest"): UILabelCopy {
  if (mode === "space_room") {
    return {
      treeSingular: "Space",
      treePlural: "Spaces",
      nestSingular: "Room",
      nestPlural: "Rooms",
      activeTrees: "Active spaces",
      liveNests: "Live rooms",
      temporaryNest: "Temporary room",
      noTree: "Temporary room",
    };
  }
  return {
    treeSingular: "Tree",
    treePlural: "Trees",
    nestSingular: "Nest",
    nestPlural: "Nests",
    activeTrees: "Active trees",
    liveNests: "Live nests",
    temporaryNest: "Temporary Nest",
    noTree: "Temporary Nest",
  };
}

export function displayNameFor(person: { displayName?: string | null; username?: string | null }) {
  return person.displayName?.trim() || person.username?.trim() || "Unknown";
}

export function presenceFromApi(presence?: Pick<UserPresence, "state" | "reachability"> | null): Presence {
  if (!presence || !presence.state || presence.state === "offline") return "offline";
  if (presence.state === "dnd") return "dnd";
  if (presence.state === "invisible") return "invisible";
  if (presence.reachability === "open") return "open";
  if (presence.reachability === "focused") return "focused";
  return "around";
}

/** You, shaped like anyone else, for your own profile page. `people` never holds you. */
export function selfPerson(data: Pick<RavenShellData, "user" | "presence" | "trees">): ShellPerson | undefined {
  const user = data.user;
  if (!user) return undefined;
  return {
    id: user.id,
    name: displayNameFor(user),
    username: user.username || undefined,
    presence: presenceFromApi(data.presence),
    treeIds: data.trees.map((tree) => tree.id),
    activeNestIds: [],
    relationship: "context",
  };
}

export function presenceForActiveNest(presence?: Partial<Pick<UserPresence, "state" | "reachability">> | null): {
  state: UserPresenceState;
  reachability: UserReachability;
} {
  if (presence?.state === "dnd") return { state: "dnd", reachability: "unavailable" };
  if (presence?.state === "invisible") return { state: "invisible", reachability: "unavailable" };
  const reachability = presence?.reachability;
  return {
    state: "in_nest",
    reachability: reachability === "open" || reachability === "focused" || reachability === "around" ? reachability : "around",
  };
}

export function lifecycleLabel(nest: Pick<Nest, "lifecycleState" | "type">) {
  if (nest.lifecycleState === "active") return "Live";
  if (nest.lifecycleState === "empty") return nest.type === "temporary" ? "Empty, expiring" : "Empty";
  if (nest.lifecycleState === "waiting") return "Waiting";
  if (nest.lifecycleState === "ready") return "Ready";
  if (nest.lifecycleState === "expired") return "Expired";
  if (nest.lifecycleState === "closed") return "Closed";
  return "Created";
}

export function formatRelativeTime(value?: string | null) {
  if (!value) return "";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const diffMs = timestamp - Date.now();
  const abs = Math.abs(diffMs);
  const minutes = Math.max(1, Math.round(abs / 60000));
  if (minutes < 60) return diffMs >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return diffMs >= 0 ? `in ${hours}h` : `${hours}h ago`;
}
