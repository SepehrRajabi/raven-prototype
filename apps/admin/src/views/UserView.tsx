import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import type { AdminApi } from "../api";
import type { AdminUser, CapabilityMode, SessionUser, UserCapability, UserDetail } from "../types";
import { ImageViewer } from "../components/ImageViewer";
import { SendMessageDialog } from "../components/SendMessageDialog";
import { Badge, Button, ConfirmDialog, Dialog, Field, Input, List, Loading, Notice, PageHeader, Row, Section, Select, TemporaryPasswordDialog } from "../components/ui";
import { CAPABILITY_LIMITS, CAPABILITY_TEXT, describeEffective, formatAgo, formatDate, formatDateTime } from "../lib/format";
import { IMAGE_TYPES, imageProblem } from "../lib/image";
import { routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

type Pending = "suspend" | "reactivate" | "reset" | "role" | "sign-out" | "rename" | null;

export function UserView({ api, userId, me }: { api: AdminApi; userId: string; me: SessionUser }) {
  const detail = useLoad(() => api.user(userId), userId);
  const [pending, setPending] = useState<Pending>(null);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [messaging, setMessaging] = useState(false);
  const [error, setError] = useState("");

  if (detail.error && !detail.data) {
    return (
      <>
        <Back />
        <Notice>{detail.error}</Notice>
      </>
    );
  }
  if (!detail.data) return <Loading />;
  const { user, capabilities, sessions, spaces } = detail.data;
  const isSelf = user.id === me.id;
  const isAdmin = user.role === "admin";
  const apply = (next: UserDetail) => {
    detail.set(next);
    setError("");
  };

  return (
    <>
      <Back />
      <PageHeader
        title={user.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            @{user.username}
            {isAdmin ? <Badge>Admin</Badge> : null}
            {user.status === "suspended" ? <Badge tone="destructive">Suspended</Badge> : <Badge tone="live">Active</Badge>}
            {user.mustChangePassword ? <Badge tone="warning">Temporary password</Badge> : null}
            {isSelf ? <Badge>You</Badge> : null}
          </span>
        }
        actions={
          <>
            {user.status === "active" ? (
              <Button size="sm" onClick={() => setMessaging(true)}>
                Send a message
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setPending("rename")}>
              Edit name
            </Button>
          </>
        }
      />
      {error ? <div className="mb-4"><Notice>{error}</Notice></div> : null}
      {user.status === "suspended" ? (
        <div className="mb-6">
          <Notice tone="warning">This account is suspended{user.statusReason ? `: ${user.statusReason}` : ""}. It cannot sign in.</Notice>
        </div>
      ) : null}

      <dl className="mb-8 grid grid-cols-2 gap-x-6 gap-y-3 text-small sm:grid-cols-4">
        <Fact label="Created" value={formatDate(user.createdAt)} />
        <Fact label="Last seen" value={formatAgo(user.lastSeenAt)} />
        <Fact label="Password changed" value={formatDate(user.passwordChangedAt)} />
        <Fact label="Signed-in devices" value={String(sessions.length)} />
        {detail.data.invitedBy ? <Fact label="Invited by" value={`${detail.data.invitedBy.displayName} (@${detail.data.invitedBy.username})`} /> : null}
      </dl>

      <Section
        title="Permissions"
        description={
          isAdmin
            ? "Administrators can do everything. These apply only if the account is made an ordinary user."
            : "Default follows the server setting. Allow and Don’t allow apply to this account whatever the default is."
        }
      >
        <List>
          {capabilities.map((capability) => (
            <CapabilityRow key={capability.capability} api={api} userId={user.id} capability={capability} isAdmin={isAdmin} onChanged={apply} onError={setError} />
          ))}
        </List>
      </Section>

      <Section title="Spaces" description="Managed from each space’s page.">
        <List empty="Not in any space.">
          {spaces.map((space) => (
            <Row key={space.id} href={routeHref({ page: "space", id: space.id })}>
              <span className="min-w-0 flex-1 truncate font-medium">{space.name}</span>
              <Badge>{roleLabel(space.role)}</Badge>
              <span className="hidden w-32 text-right text-small text-subtle sm:block">Joined {formatDate(space.joinedAt)}</span>
            </Row>
          ))}
        </List>
      </Section>

      <Section
        title="Signed-in devices"
        actions={
          sessions.length > 0 ? (
            <Button size="sm" onClick={() => setPending("sign-out")}>
              {isSelf ? "Sign out other devices" : "Sign out everywhere"}
            </Button>
          ) : null
        }
      >
        <List empty="Not signed in anywhere.">
          {sessions.map((session) => (
            <Row key={session.id}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {session.deviceName} <span className="font-normal text-muted-foreground">· {session.os}</span>
                </p>
                <p className="truncate text-small text-subtle">
                  {session.latestIp || "Unknown address"} · signed in {formatDateTime(session.createdAt)}
                </p>
              </div>
              <span className="text-small text-subtle">{formatAgo(session.lastAccessedAt)}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Sign out ${session.deviceName}`}
                onClick={() => {
                  api
                    .revokeSession(user.id, session.id)
                    .then(() => detail.reload())
                    .catch((cause: unknown) => setError(errorMessage(cause)));
                }}
              >
                Sign out
              </Button>
            </Row>
          ))}
        </List>
      </Section>

      <Section title="Account">
        <List>
          <ProfilePicture key={user.updatedAt} api={api} user={user} onChanged={detail.reload} onError={setError} />
          <Row>
            <div className="min-w-0 flex-1">
              <p className="font-medium">Password</p>
              <p className="text-small text-muted-foreground">Make a temporary password to pass on. They are signed out and choose a new one.</p>
            </div>
            <Button size="sm" disabled={isSelf} title={isSelf ? "Change your own password in the Raven app." : undefined} onClick={() => setPending("reset")}>
              Reset password
            </Button>
          </Row>
          <Row>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{isAdmin ? "Administrator" : "Ordinary user"}</p>
              <p className="text-small text-muted-foreground">{isAdmin ? "Can use this dashboard." : "Cannot use this dashboard."}</p>
            </div>
            <Button size="sm" disabled={isSelf} onClick={() => setPending("role")}>
              {isAdmin ? "Remove administrator" : "Make administrator"}
            </Button>
          </Row>
          <Row>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{user.status === "suspended" ? "Reactivate" : "Suspend"}</p>
              <p className="text-small text-muted-foreground">
                {user.status === "suspended" ? "Let this account sign in again." : "Sign them out everywhere, end their calls and stop them signing in. Nothing they made is removed."}
              </p>
            </div>
            {user.status === "suspended" ? (
              <Button size="sm" onClick={() => setPending("reactivate")}>
                Reactivate
              </Button>
            ) : (
              <Button size="sm" variant="destructive" disabled={isSelf} onClick={() => setPending("suspend")}>
                Suspend
              </Button>
            )}
          </Row>
        </List>
      </Section>

      {messaging ? <SendMessageDialog api={api} title={`Message ${user.displayName}`} audiences={[{ label: user.displayName, to: [user.id] }]} onClose={() => setMessaging(false)} /> : null}
      {pending === "suspend" ? <SuspendDialog api={api} detail={detail.data} onClose={() => setPending(null)} onDone={apply} /> : null}
      {pending === "rename" ? <RenameDialog api={api} detail={detail.data} onClose={() => setPending(null)} onDone={apply} /> : null}
      {pending === "reactivate" ? (
        <ConfirmDialog title={`Reactivate ${user.username}?`} body="They will be able to sign in again with the password they had." confirmLabel="Reactivate" onClose={() => setPending(null)} onConfirm={async () => apply(await api.reactivateUser(user.id))} />
      ) : null}
      {pending === "reset" ? (
        <ConfirmDialog
          title={`Reset ${user.username}’s password?`}
          body="Their current password stops working and they are signed out on every device. You get a temporary password to pass on."
          confirmLabel="Reset password"
          onClose={() => setPending(null)}
          onConfirm={async () => {
            setTemporaryPassword(await api.resetPassword(user.id));
            detail.reload();
          }}
        />
      ) : null}
      {pending === "role" ? (
        <ConfirmDialog
          title={isAdmin ? `Remove ${user.username} as administrator?` : `Make ${user.username} an administrator?`}
          body={isAdmin ? "They lose access to this dashboard and their permissions apply again." : "They will be able to do everything you can do here, including to your account."}
          confirmLabel={isAdmin ? "Remove administrator" : "Make administrator"}
          typeToConfirm={isAdmin ? undefined : user.username}
          onClose={() => setPending(null)}
          onConfirm={async () => apply(await api.updateUser(user.id, { role: isAdmin ? "user" : "admin" }))}
        />
      ) : null}
      {pending === "sign-out" ? (
        <ConfirmDialog
          title={isSelf ? "Sign out your other devices?" : `Sign ${user.username} out everywhere?`}
          body="They can sign back in with their password. Use Suspend to keep them out."
          confirmLabel="Sign out"
          onClose={() => setPending(null)}
          onConfirm={async () => {
            await api.revokeSessions(user.id);
            detail.reload();
          }}
        />
      ) : null}
      {temporaryPassword ? <TemporaryPasswordDialog username={user.username} password={temporaryPassword} onClose={() => setTemporaryPassword("")} /> : null}
    </>
  );
}

function Back() {
  return (
    <a href={routeHref({ page: "users" })} className="mb-4 inline-flex items-center gap-1.5 text-small text-muted-foreground hover:text-foreground">
      <ArrowLeft size={14} aria-hidden />
      Users
    </a>
  );
}

function ProfilePicture({ api, user, onChanged, onError }: { api: AdminApi; user: AdminUser; onChanged: () => void; onError: (message: string) => void }) {
  // Remounted with each new updatedAt, which is also the picture's cache-busting version.
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [viewing, setViewing] = useState(false);
  const closeViewer = useCallback(() => setViewing(false), []);
  const picture = `/v1/media/users/${user.id}/avatar?v=${encodeURIComponent(user.updatedAt)}`;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const problem = imageProblem(file);
    if (problem) {
      onError(problem);
      return;
    }
    setBusy(true);
    try {
      await api.uploadUserImage(user.id, file);
      onChanged();
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row>
      {missing ? (
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent text-small font-medium text-subtle">{user.displayName.charAt(0).toUpperCase()}</div>
      ) : (
        <button type="button" aria-label={`Open ${user.displayName}’s profile picture`} onClick={() => setViewing(true)} className="h-12 w-12 shrink-0 cursor-zoom-in rounded-full">
          <img src={picture} alt="" className="h-full w-full rounded-full bg-accent object-cover" onError={() => setMissing(true)} />
        </button>
      )}
      {viewing && !missing ? <ImageViewer src={picture} alt={`${user.displayName}’s profile picture`} saveName={`${user.username}-profile-picture`} onClose={closeViewer} /> : null}
      <div className="min-w-0 flex-1">
        <p className="font-medium">Profile picture</p>
        <p className="text-small text-muted-foreground">A square PNG, JPEG or WebP, up to 512 KB. It changes on their devices straight away.</p>
      </div>
      {missing ? null : (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>
          Remove
        </Button>
      )}
      <label className="inline-flex h-8 cursor-pointer items-center rounded-control bg-secondary px-3 text-small font-medium text-secondary-foreground hover:bg-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
        {busy ? "Uploading…" : "Change picture"}
        <input type="file" accept={IMAGE_TYPES.join(",")} className="sr-only" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
      </label>
      {removing ? (
        <ConfirmDialog
          title={`Remove ${user.username}’s picture?`}
          body="The picture is deleted and the Raven app shows their initial instead. They can set a new one."
          confirmLabel="Remove picture"
          onClose={() => setRemoving(false)}
          onConfirm={async () => {
            await api.removeUserImage(user.id);
            onChanged();
          }}
        />
      ) : null}
    </Row>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-caption text-subtle">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}

export function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface CapabilityRowProps {
  api: AdminApi;
  userId: string;
  capability: UserCapability;
  isAdmin: boolean;
  onChanged: (detail: UserDetail) => void;
  onError: (message: string) => void;
}

function CapabilityRow({ api, userId, capability, isAdmin, onChanged, onError }: CapabilityRowProps) {
  const text = CAPABILITY_TEXT[capability.capability];
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(capability.limit === null ? "" : String(capability.limit));
  const save = async (mode: CapabilityMode, nextLimit: string) => {
    const parsed = nextLimit.trim() === "" ? null : Number.parseInt(nextLimit, 10);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 1)) {
      onError("A limit must be a whole number of 1 or more, or empty for no limit.");
      return;
    }
    setBusy(true);
    try {
      onChanged(await api.setUserCapability(userId, capability.capability, mode, mode === "allow" ? parsed : null));
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const defaultText = capability.defaultAllowed
    ? capability.defaultLimit !== null
      ? `Default (allowed, up to ${capability.defaultLimit})`
      : "Default (allowed)"
    : "Default (not allowed)";
  const limitText = CAPABILITY_LIMITS[capability.capability];
  const showLimit = limitText !== undefined && capability.mode === "allow";
  return (
    <Row>
      <div className="min-w-0 flex-1 py-1">
        <p className="font-medium">{text.title}</p>
        <p className="text-small text-muted-foreground">{text.description}</p>
        <p className={capability.effective || isAdmin ? "mt-1 text-caption text-subtle" : "mt-1 text-caption text-warning"}>{describeEffective(capability, isAdmin)}</p>
      </div>
      {showLimit ? (
        <Input
          className="w-24"
          inputMode="numeric"
          aria-label={limitText?.label}
          placeholder="No limit"
          value={limit}
          disabled={busy}
          onChange={(event) => setLimit(event.target.value)}
          onBlur={() => {
            if (limit !== (capability.limit === null ? "" : String(capability.limit))) void save("allow", limit);
          }}
        />
      ) : null}
      <Select aria-label={text.title} value={capability.mode} disabled={busy} onChange={(event) => void save(event.target.value as CapabilityMode, limit)}>
        <option value="inherit">{defaultText}</option>
        <option value="allow">Allow</option>
        <option value="deny">Don’t allow</option>
      </Select>
    </Row>
  );
}

function SuspendDialog({ api, detail, onClose, onDone }: { api: AdminApi; detail: UserDetail; onClose: () => void; onDone: (detail: UserDetail) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owned = detail.spaces.filter((space) => space.role === "owner");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await api.suspendUser(detail.user.id, reason.trim()));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Suspend ${detail.user.username}?`} onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <p className="text-body text-muted-foreground">They are signed out everywhere, put out of any call, and cannot sign in until you reactivate them. Their messages and spaces stay.</p>
        {owned.length > 0 ? (
          <Notice tone="warning">
            They own {owned.map((space) => space.name).join(", ")}. {owned.length === 1 ? "That space keeps" : "Those spaces keep"} working, but only an owner can change settings or roles. Transfer ownership from the space’s page if someone else should run it.
          </Notice>
        ) : null}
        <Field label="Reason" hint="Optional. Kept in the audit log, not shown to them.">
          {(id) => <Input id={id} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={busy}>
            {busy ? "Suspending…" : "Suspend"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RenameDialog({ api, detail, onClose, onDone }: { api: AdminApi; detail: UserDetail; onClose: () => void; onDone: (detail: UserDetail) => void }) {
  const [displayName, setDisplayName] = useState(detail.user.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onDone(await api.updateUser(detail.user.id, { displayName: displayName.trim() }));
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title="Display name" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Display name" hint="Leave empty to show the username.">
          {(id) => <Input id={id} value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
