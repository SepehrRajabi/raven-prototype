import type { CapabilityName, UserCapability } from "../types";

export function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "3 minutes ago", for when someone was last seen. */
export function formatAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "Never";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "Unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "Just now";
  const steps: Array<[number, string]> = [
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let amount = Math.floor(seconds / 60);
  for (const [size, unit] of steps) {
    if (amount < size) return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
    amount = Math.floor(amount / size);
  }
  return "Long ago";
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const CAPABILITY_TEXT: Record<CapabilityName, { title: string; description: string }> = {
  "spaces.create": { title: "Create spaces", description: "Make their own spaces. A limit caps how many they may own." },
  "rooms.join": { title: "Join rooms", description: "Enter voice rooms, in a space or outside one." },
  "rooms.start_adhoc": { title: "Start rooms outside a space", description: "Start a temporary voice room for a quick call. Needs Join rooms." },
  "messages.read": { title: "Read messages", description: "See direct messages, groups and text rooms. Off hides chat entirely." },
  "messages.send": { title: "Send messages", description: "Write in conversations they can read. Needs Read messages." },
  "groups.create": { title: "Create group chats", description: "Start a group conversation with friends. Needs Read messages." },
  "invites.create": { title: "Invite people", description: "Make single-use invite codes for friends. Needs Invitations turned on. A limit caps open invites." },
  "workshop.share_ports": { title: "Share ports", description: "Share a port from their computer with others in a call or room, through the relay. Also needs port sharing turned on for the server." },
  "workshop.use_ports": { title: "Use shared ports", description: "Connect to ports others have shared in a call or room." },
};

/** The capabilities that take a limit, and what the limit counts. */
export const CAPABILITY_LIMITS: Partial<Record<CapabilityName, { one: string; many: string; label: string }>> = {
  "spaces.create": { one: "space", many: "spaces", label: "Most spaces one account may own" },
  "invites.create": { one: "open invite", many: "open invites", label: "Most open invites one account may have" },
};

/** What a capability comes to for one account, in words. */
export function describeEffective(capability: UserCapability, isAdmin: boolean): string {
  // Inviting needs the server's Invitations switch, which holds for administrators too.
  const switchedOff = capability.capability === "invites.create" ? "Not allowed (Invitations are off)" : "Not allowed (needs another permission)";
  if (isAdmin) return capability.capability === "invites.create" && !capability.effective ? switchedOff : "Allowed (administrator)";
  if (!capability.effective) {
    const wouldBeAllowed = capability.mode === "allow" || (capability.mode === "inherit" && capability.defaultAllowed);
    return wouldBeAllowed ? switchedOff : "Not allowed";
  }
  const limit = CAPABILITY_LIMITS[capability.capability];
  if (limit && capability.effectiveLimit !== null) {
    return `Allowed, up to ${plural(capability.effectiveLimit, limit.one, limit.many)}`;
  }
  return "Allowed";
}

const ACTION_TEXT: Record<string, string> = {
  "user.created": "Created account",
  "user.updated": "Changed account",
  "user.image_changed": "Changed profile picture",
  "user.image_removed": "Removed profile picture",
  "user.suspended": "Suspended account",
  "user.reactivated": "Reactivated account",
  "user.password_reset": "Reset password",
  "user.capabilities_changed": "Changed permissions",
  "user.sessions_revoked": "Signed out everywhere",
  "user.session_revoked": "Signed out a device",
  "space.created": "Created space",
  "space.settings_changed": "Changed space settings",
  "space.deleted": "Deleted space",
  "space.ownership_transferred": "Transferred ownership",
  "space.member_added": "Added member",
  "space.member_removed": "Removed member",
  "space.member_role_changed": "Changed member role",
  "room.created": "Created room",
  "room.renamed": "Renamed room",
  "room.removed": "Removed room",
  "settings.capability_defaults_changed": "Changed default permissions",
  "settings.server_image_changed": "Changed server image",
  "settings.accounts_changed": "Changed who can join",
  "user.signed_up": "Signed up",
  "invite.created": "Made an invite",
  "invite.revoked": "Withdrew an invite",
  "library.unpublished": "Unpublished a GIF or sticker",
  "library.deleted": "Deleted a GIF or sticker",
};

export function describeAction(action: string): string {
  return ACTION_TEXT[action] ?? action;
}

/** A short, readable form of an audit event's details. Ids are left out. */
export function describeDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined || value === "") continue;
    if (key.endsWith("Id") || key === "from" || key === "to") continue;
    parts.push(`${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(" · ");
}
