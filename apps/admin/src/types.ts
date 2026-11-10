// The shapes the admin API returns (services/api/internal/http/admin*.go).

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "suspended";
export type SpaceRole = "owner" | "moderator" | "member";

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
}

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  statusReason: string;
  mustChangePassword: boolean;
  passwordChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  activeSessions: number;
  spaceCount: number;
}

export type CapabilityName =
  | "spaces.create"
  | "rooms.join"
  | "rooms.start_adhoc"
  | "messages.read"
  | "messages.send"
  | "groups.create"
  | "invites.create"
  | "workshop.share_ports"
  | "workshop.use_ports";

export type CapabilityMode = "inherit" | "allow" | "deny";

export interface UserCapability {
  capability: CapabilityName;
  mode: CapabilityMode;
  limit: number | null;
  defaultAllowed: boolean;
  defaultLimit: number | null;
  effective: boolean;
  effectiveLimit: number | null;
}

export interface CapabilityDefault {
  capability: CapabilityName;
  allowed: boolean;
  limit: number | null;
}

export interface UserSession {
  id: string;
  latestIp: string;
  userAgent: string;
  os: string;
  deviceName: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
}

export interface UserSpace {
  id: string;
  name: string;
  role: SpaceRole;
  joinedAt: string | null;
}

export interface UserDetail {
  user: AdminUser;
  capabilities: UserCapability[];
  sessions: UserSession[];
  spaces: UserSpace[];
  /** Whose invite code they joined with, if any. */
  invitedBy: { id: string; username: string; displayName: string } | null;
}

/** The server's two switches for new accounts. */
export interface AccountSettings {
  signUpOpen: boolean;
  invitationsOpen: boolean;
}

export interface AdminSpace {
  id: string;
  name: string;
  description: string;
  joinPolicy: "free" | "request";
  visibility: "public" | "private";
  createdAt: string;
  updatedAt: string;
  ownerId: string;
  ownerUsername: string;
  ownerStatus: UserStatus | "";
  memberCount: number;
  voiceRooms: number;
  textRooms: number;
}

export interface SpaceMember {
  userId: string;
  username: string;
  /** The name shown in this space: the nickname if there is one, else the usual name. */
  displayName: string;
  /** The nickname set in this space, empty when none. */
  nickname: string;
  role: SpaceRole;
  status: UserStatus;
  joinedAt: string | null;
}

export interface Room {
  id: string;
  kind: "voice" | "text";
  name: string;
  createdAt: string;
  peopleInCall: number;
}

export interface SpaceDetail {
  space: AdminSpace;
  members: SpaceMember[];
  rooms: Room[];
}

export interface Overview {
  users: number;
  suspendedUsers: number;
  admins: number;
  spaces: number;
  voiceRooms: number;
  textRooms: number;
  liveCalls: number;
  peopleInCalls: number;
}

export interface AuditEvent {
  id: string;
  actorUserId?: string;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  detail?: Record<string, unknown>;
  createdAt: string;
}

export interface AdminLibraryItem {
  id: string;
  assetId: string;
  kind: "gif" | "sticker";
  format: "webm" | "webp" | "tgs";
  title: string;
  keywords: string[];
  width: number;
  height: number;
  durationMs: number;
  ownerId: string;
  ownerUsername: string;
  publishedAt: string;
}
