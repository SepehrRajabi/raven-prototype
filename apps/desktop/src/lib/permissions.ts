import type { TreeDetails, TreeRole, User, UserCapabilities } from "./api";

/**
 * What someone may do in a tree. The server decides (services/api/internal/http/policy.go)
 * and sends the answer with the tree as `viewer.permissions`; views ask here instead of
 * comparing role names, so the client and the server cannot drift apart.
 */
export type TreePermission =
  | "rooms.manage"
  | "members.manage"
  | "members.remove"
  | "messages.moderate"
  | "voice.moderate"
  | "members.rename"
  | "board.manage"
  | "stickers.manage"
  | "settings.edit"
  | "roles.assign"
  | "ownership.transfer"
  | "space.delete"
  | "leave";

const RANK: Record<TreeRole, number> = { owner: 3, moderator: 2, member: 1 };

export function treeViewerRole(details: TreeDetails | undefined, userId: string | undefined): TreeRole | undefined {
  if (!details) return undefined;
  return details.viewer?.role ?? details.members.find((member) => member.userId === userId)?.role;
}

export function treeCan(details: TreeDetails | undefined, permission: TreePermission): boolean {
  return Boolean(details?.viewer?.permissions.includes(permission));
}

/** Acting on a person (removing them) also needs the viewer to outrank them. */
export function treeOutranks(details: TreeDetails | undefined, targetRole: TreeRole): boolean {
  const role = details?.viewer?.role;
  return role ? RANK[role] > RANK[targetRole] : false;
}

const EVERYTHING: UserCapabilities = {
  createSpaces: true,
  maxOwnedSpaces: null,
  joinRooms: true,
  startRooms: true,
  readMessages: true,
  sendMessages: true,
  createGroups: true,
  // Invitations came later than the rest and start off.
  createInvites: false,
  maxOpenInvites: null,
};

/**
 * What the server's administrator lets this account do. A server from before these
 * existed sends none, which means everything, as it did then.
 */
export function capabilitiesOf(user: User | null | undefined): UserCapabilities {
  return user?.capabilities ?? EVERYTHING;
}

/**
 * Whether you may mute or deafen someone in this room, so the menu is only offered when the
 * server would accept it. A space goes by rank; a temporary call belongs to whoever started it.
 */
export function canModerateVoice(
  nest: { creatorUserId: string; treeId?: string | null; type: string },
  details: TreeDetails | undefined,
  viewerId: string,
  targetId: string,
): boolean {
  if (viewerId === targetId) return false;
  if (!nest.treeId || nest.type !== "persistent") return nest.creatorUserId === viewerId;
  const target = details?.members.find((member) => member.userId === targetId);
  return Boolean(target) && treeCan(details, "voice.moderate") && treeOutranks(details, target!.role);
}
