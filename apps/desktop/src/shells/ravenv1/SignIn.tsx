import { FormEvent, useEffect, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { hostOf, type SavedAccount } from "@/lib/accounts";
import { api, type SignUpRequest } from "@/lib/api";
import type { AccountsOffered } from "@/lib/invites";
import { AccountSummary } from "./atoms";
import { PasswordChangeForm } from "./PasswordChangeForm";

/** Sign in or create an account, on the server of the person's choosing. The caller frames it. */
export function ShellLogin({
  busy,
  error,
  notice,
  serverName,
  serverDescription,
  serverAvatar,
  apiServerUrl,
  apiServerHistory,
  onServerSelect,
  accounts,
  onLogin,
  savedAccounts,
  onSwitchAccount,
  onSignUp,
}: {
  busy: boolean;
  error: string;
  notice: string;
  serverName: string;
  serverDescription: string;
  serverAvatar: string;
  apiServerUrl: string;
  apiServerHistory: string[];
  onServerSelect: (url: string) => Promise<void>;
  accounts: AccountsOffered;
  onLogin: (username: string, password: string) => Promise<void>;
  savedAccounts: SavedAccount[];
  onSwitchAccount: (account: SavedAccount) => void;
  onSignUp: (request: SignUpRequest) => Promise<void>;
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const canSignUp = accounts.signUp || accounts.invitations;
  const creating = mode === "sign-up" && canSignUp;
  // A code is needed unless the server takes anyone.
  const needsCode = creating && !accounts.signUp;
  const [serverUrl, setServerUrl] = useState(apiServerUrl);
  const [editingServer, setEditingServer] = useState(!apiServerUrl);
  const [serverError, setServerError] = useState("");

  useEffect(() => {
    setServerUrl(apiServerUrl);
  }, [apiServerUrl]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setServerError("");
    try {
      await onServerSelect(serverUrl);
      if (creating) {
        await onSignUp({ username, displayName, password, inviteCode: accounts.invitations ? inviteCode : "" });
      } else {
        await onLogin(username, password);
      }
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "That does not look like a Raven server address.");
      setEditingServer(true);
    }
  };

  const otherServers = apiServerHistory.filter((url) => url !== serverUrl);
  const name = serverName || "Raven";

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-[360px]">
        <div className="mb-8 text-center">
          <Avatar name={name} src={serverAvatar ? api.assetUrl(serverAvatar) : undefined} className="mx-auto h-12 w-12 rounded-card bg-foreground text-title text-background" />
          <h1 className="mt-4 text-display font-semibold">{creating ? `Join ${name}` : `Sign in to ${name}`}</h1>
          {serverDescription ? <p className="mt-1 text-small text-muted-foreground">{serverDescription}</p> : null}
        </div>
        {savedAccounts.length > 0 ? (
          <div className="mb-6">
            <p className="px-2.5 pb-1 text-caption text-subtle">Saved accounts</p>
            {savedAccounts.map((account) => (
              <button
                key={`${account.serverUrl}|${account.sessionId}`}
                type="button"
                disabled={busy}
                onClick={() => onSwitchAccount(account)}
                className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition-colors hover:bg-secondary disabled:opacity-45"
              >
                <AccountSummary account={account} accounts={savedAccounts} active={false} />
              </button>
            ))}
          </div>
        ) : null}
        <form className="space-y-4" onSubmit={submit}>
          {creating && accounts.invitations ? (
            <label className="block space-y-1.5 text-small text-muted-foreground" htmlFor="ravenv1-invite">
              {accounts.signUp ? "Invite code (optional)" : "Invite code"}
              <Input id="ravenv1-invite" className="rv-mono" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="XXXXX-XXXXX" spellCheck={false} autoComplete="off" autoFocus />
            </label>
          ) : null}
          {creating ? (
            <label className="block space-y-1.5 text-small text-muted-foreground" htmlFor="ravenv1-display-name">
              Display name
              <Input id="ravenv1-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" autoFocus={!accounts.invitations} />
            </label>
          ) : null}
          <label className="block space-y-1.5 text-small text-muted-foreground" htmlFor="ravenv1-username">
            Username
            <Input id="ravenv1-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus={!creating} />
          </label>
          <label className="block space-y-1.5 text-small text-muted-foreground" htmlFor="ravenv1-password">
            Password
            <Input id="ravenv1-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={creating ? "new-password" : "current-password"} />
          </label>
          {serverError || error ? <p role="alert" className="text-small text-destructive">{serverError || error}</p> : null}
          {notice && !serverError && !error ? <p role="status" className="text-small text-muted-foreground">{notice}</p> : null}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !serverUrl || !username || !password || (needsCode && !inviteCode.trim())}>
            {creating ? (busy ? "Creating your account…" : "Create account") : busy ? "Signing in…" : "Sign in"}
          </Button>
          {canSignUp ? (
            <p className="text-center text-small text-muted-foreground">
              {creating ? "Already have an account? " : "New here? "}
              <button
                type="button"
                className="rounded-chip text-foreground underline-offset-4 hover:underline"
                onClick={() => setMode(creating ? "sign-in" : "sign-up")}
              >
                {creating ? "Sign in" : "Create an account"}
              </button>
            </p>
          ) : null}

          <div className="border-t border-border pt-4">
            {editingServer ? (
              <div className="space-y-2">
                <label className="block space-y-1.5 text-small text-muted-foreground" htmlFor="ravenv1-server">
                  Server address
                  <Input id="ravenv1-server" className="rv-mono" value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://raven.example.org" spellCheck={false} />
                </label>
                {otherServers.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {otherServers.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => setServerUrl(url)}
                        className="rv-mono rounded-chip bg-secondary px-2 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        {hostOf(url)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <p className="text-caption text-subtle">Your account, calls and data live on the server you choose. Raven can be self-hosted.</p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 text-small">
                <span className="min-w-0 truncate text-muted-foreground">
                  Server: <span className="rv-mono text-foreground">{hostOf(serverUrl)}</span>
                </span>
                <button type="button" className="shrink-0 rounded-chip text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline" onClick={() => setEditingServer(true)}>
                  Change
                </button>
              </div>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

/** Shown to someone who signed in with a temporary password: nothing else until it is replaced. The caller frames it. */
export function ChoosePassword({ onChange, onLogout }: { onChange: (currentPassword: string, newPassword: string) => Promise<void>; onLogout: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="w-full max-w-[380px]">
        <h1 className="text-title font-semibold">Choose your password</h1>
        <p className="mb-5 mt-1.5 text-body text-muted-foreground">
          You signed in with a temporary password. Replace it with one only you know to continue.
        </p>
        <PasswordChangeForm currentLabel="Temporary password" onChange={onChange} />
        <Button variant="ghost" className="mt-3" onClick={onLogout}>Sign out</Button>
      </div>
    </div>
  );
}
