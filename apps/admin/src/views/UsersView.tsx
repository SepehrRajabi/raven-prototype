import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Plus, Send } from "lucide-react";
import type { AdminApi } from "../api";
import type { AdminUser, UserRole } from "../types";
import { SendMessageDialog } from "../components/SendMessageDialog";
import { Badge, Button, Dialog, Field, Input, List, Loading, Notice, PageHeader, Row, Select, TemporaryPasswordDialog } from "../components/ui";
import { formatAgo, plural } from "../lib/format";
import { navigate, routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

export function UsersView({ api }: { api: AdminApi }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [messaging, setMessaging] = useState(false);
  const [created, setCreated] = useState<{ user: AdminUser; temporaryPassword: string } | null>(null);
  // Search a moment after typing stops rather than on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed), 200);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const users = useLoad(() => api.users(query, status), `${query}|${status}`);

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with an account on this server."
        actions={
          <>
            <Button onClick={() => setMessaging(true)}>
              <Send size={16} aria-hidden />
              Send a message
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden />
              New user
            </Button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-xs" type="search" placeholder="Search by name" aria-label="Search users" value={typed} onChange={(event) => setTyped(event.target.value)} />
        <Select aria-label="Status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </Select>
      </div>
      {users.error ? <Notice>{users.error}</Notice> : null}
      {users.data ? (
        <>
          <List empty={query || status ? "No users match." : "No users yet."}>
            {users.data.map((user) => (
              <Row key={user.id} href={routeHref({ page: "user", id: user.id })}>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-medium">
                    {user.displayName}
                    {user.role === "admin" ? <Badge>Admin</Badge> : null}
                    {user.status === "suspended" ? <Badge tone="destructive">Suspended</Badge> : null}
                    {user.mustChangePassword ? <Badge tone="warning">Temporary password</Badge> : null}
                  </p>
                  <p className="truncate text-small text-muted-foreground">@{user.username}</p>
                </div>
                <p className="hidden w-24 text-right text-small text-muted-foreground sm:block">{plural(user.spaceCount, "space")}</p>
                <p className="w-32 text-right text-small text-subtle">{formatAgo(user.lastSeenAt)}</p>
              </Row>
            ))}
          </List>
          <p className="mt-3 text-caption text-subtle">{plural(users.data.length, "user")}</p>
        </>
      ) : users.loading ? (
        <Loading />
      ) : null}
      {messaging ? (
        <SendMessageDialog
          api={api}
          title="Send a message"
          audiences={[
            { label: "Everyone with an account", to: "all" },
            ...(users.data && (query || status) && users.data.length > 0 ? [{ label: `The ${plural(users.data.length, "user")} listed`, to: users.data.map((user) => user.id) }] : []),
          ]}
          onClose={() => setMessaging(false)}
        />
      ) : null}
      {creating ? (
        <CreateUserDialog
          api={api}
          onClose={() => setCreating(false)}
          onCreated={(result) => {
            setCreating(false);
            setCreated(result);
            users.reload();
          }}
        />
      ) : null}
      {created ? (
        <TemporaryPasswordDialog
          username={created.user.username}
          password={created.temporaryPassword}
          onClose={() => {
            const id = created.user.id;
            setCreated(null);
            navigate({ page: "user", id });
          }}
        />
      ) : null}
    </>
  );
}

function CreateUserDialog({ api, onClose, onCreated }: { api: AdminApi; onClose: () => void; onCreated: (result: { user: AdminUser; temporaryPassword: string }) => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(await api.createUser({ username: username.trim(), displayName: displayName.trim(), role }));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Dialog title="New user" onClose={onClose}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field label="Username" hint="3 to 32 lowercase letters, digits, dots, dashes or underscores. It cannot be changed later.">
          {(id) => <Input id={id} value={username} onChange={(event) => setUsername(event.target.value.toLowerCase())} autoComplete="off" autoCapitalize="none" spellCheck={false} required />}
        </Field>
        <Field label="Display name" hint="Optional. The username is shown if this is empty.">
          {(id) => <Input id={id} value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="off" maxLength={80} />}
        </Field>
        <Field label="Role" hint="Administrators can use this dashboard and are never limited by permissions.">
          {(id) => (
            <Select id={id} value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
              <option value="user">User</option>
              <option value="admin">Administrator</option>
            </Select>
          )}
        </Field>
        <p className="text-small text-muted-foreground">A temporary password is made for you to pass on. They choose their own when they first sign in.</p>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !username.trim()}>
            {busy ? "Creating…" : "Create user"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
