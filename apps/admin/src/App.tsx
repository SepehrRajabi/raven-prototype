import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Activity, Boxes, ClipboardList, Images, LogOut, Settings, Users } from "lucide-react";
import { ApiError, browserApi } from "./api";
import type { AdminApi } from "./api";
import type { SessionUser } from "./types";
import { Button, Field, Input, Loading, Notice, cn } from "./components/ui";
import { errorMessage } from "./lib/useLoad";
import { routeHref, useRoute } from "./lib/route";
import type { Route } from "./lib/route";
import { OverviewView } from "./views/OverviewView";
import { UsersView } from "./views/UsersView";
import { UserView } from "./views/UserView";
import { SpacesView } from "./views/SpacesView";
import { SpaceView } from "./views/SpaceView";
import { LibraryView } from "./views/LibraryView";
import { SettingsView } from "./views/SettingsView";
import { AuditView } from "./views/AuditView";

type Session = { state: "checking" } | { state: "signed-out"; notice?: string } | { state: "signed-in"; user: SessionUser };

export function App() {
  const api = useMemo(() => browserApi(), []);
  const [session, setSession] = useState<Session>({ state: "checking" });

  useEffect(() => {
    api.onSignedOut = () => setSession({ state: "signed-out", notice: "You were signed out. Sign in again to continue." });
    if (!api.signedIn) {
      setSession({ state: "signed-out" });
      return;
    }
    api
      .me()
      .then((user) => setSession({ state: "signed-in", user }))
      .catch((cause: unknown) => {
        // A 401 has already been handled by onSignedOut with its own notice.
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setSession({ state: "signed-out", notice: errorMessage(cause) });
        }
      });
  }, [api]);

  const signOut = useCallback(async () => {
    await api.signOut();
    setSession({ state: "signed-out" });
  }, [api]);

  if (session.state === "checking") {
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  }
  if (session.state === "signed-out") {
    return <SignIn api={api} notice={session.notice} onSignedIn={(user) => setSession({ state: "signed-in", user })} />;
  }
  if (session.user.mustChangePassword) {
    return <ChoosePassword api={api} user={session.user} onDone={(user) => setSession({ state: "signed-in", user })} onSignOut={signOut} />;
  }
  return <Shell api={api} user={session.user} onSignOut={signOut} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="grid min-h-screen place-items-center p-6">{children}</main>;
}

function SignIn({ api, notice, onSignedIn }: { api: AdminApi; notice?: string; onSignedIn: (user: SessionUser) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onSignedIn(await api.signIn(username, password));
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Centered>
      <form onSubmit={(event) => void submit(event)} className="grid w-full max-w-sm gap-4 rounded-panel bg-card p-8">
        <div>
          <h1 className="text-display font-semibold">Raven Admin</h1>
          <p className="mt-1 text-small text-muted-foreground">Sign in with an administrator account.</p>
        </div>
        {notice && !error ? <Notice tone="neutral">{notice}</Notice> : null}
        <Field label="Username">
          {(id) => <Input id={id} value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />}
        </Field>
        <Field label="Password">
          {(id) => <Input id={id} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <Button type="submit" variant="primary" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Centered>
  );
}

function ChoosePassword({ api, user, onDone, onSignOut }: { api: AdminApi; user: SessionUser; onDone: (user: SessionUser) => void; onSignOut: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) {
      setError("The two new passwords don’t match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onDone({ ...(await api.changeOwnPassword(current, next)), role: user.role });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Centered>
      <form onSubmit={(event) => void submit(event)} className="grid w-full max-w-sm gap-4 rounded-panel bg-card p-8">
        <div>
          <h1 className="text-title font-semibold">Choose a new password</h1>
          <p className="mt-1 text-small text-muted-foreground">You signed in with a temporary password. Replace it to continue.</p>
        </div>
        <Field label="Temporary password">
          {(id) => <Input id={id} type="password" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" required />}
        </Field>
        <Field label="New password" hint="At least 10 characters.">
          {(id) => <Input id={id} type="password" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" minLength={10} required />}
        </Field>
        <Field label="New password again">
          {(id) => <Input id={id} type="password" value={again} onChange={(event) => setAgain(event.target.value)} autoComplete="new-password" required />}
        </Field>
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save password"}
          </Button>
        </div>
      </form>
    </Centered>
  );
}

const NAV: Array<{ route: Route; label: string; icon: typeof Users; match: Route["page"][] }> = [
  { route: { page: "overview" }, label: "Overview", icon: Activity, match: ["overview"] },
  { route: { page: "users" }, label: "Users", icon: Users, match: ["users", "user"] },
  { route: { page: "spaces" }, label: "Spaces", icon: Boxes, match: ["spaces", "space"] },
  { route: { page: "library" }, label: "GIFs and stickers", icon: Images, match: ["library"] },
  { route: { page: "settings" }, label: "Settings", icon: Settings, match: ["settings"] },
  { route: { page: "audit" }, label: "Audit log", icon: ClipboardList, match: ["audit"] },
];

function Shell({ api, user, onSignOut }: { api: AdminApi; user: SessionUser; onSignOut: () => void }) {
  const route = useRoute();
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <nav aria-label="Sections" className="flex shrink-0 flex-col gap-1 p-3 md:sticky md:top-0 md:h-screen md:w-56">
        <p className="px-3 py-2 text-title-sm font-semibold">Raven Admin</p>
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map((item) => {
            const active = item.match.includes(route.page);
            return (
              <li key={item.label}>
                <a
                  href={routeHref(item.route)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-9 items-center gap-2.5 whitespace-nowrap rounded-control px-3 text-small transition-colors",
                    active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                >
                  <item.icon size={16} aria-hidden />
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
        <div className="mt-auto hidden items-center justify-between gap-2 px-3 py-2 md:flex">
          <span className="min-w-0 truncate text-small text-muted-foreground" title={user.username}>
            {user.displayName}
          </span>
          <button type="button" onClick={onSignOut} aria-label="Sign out" title="Sign out" className="grid h-7 w-7 shrink-0 place-items-center rounded-chip text-muted-foreground hover:bg-secondary hover:text-foreground">
            <LogOut size={15} aria-hidden />
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 p-3 md:pl-0">
        <div className="min-h-full rounded-panel bg-card px-5 py-6 md:px-8">
          <div className="mx-auto max-w-4xl">
            <Page api={api} route={route} me={user} />
          </div>
        </div>
        <div className="p-3 md:hidden">
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut size={14} aria-hidden />
            Sign out {user.displayName}
          </Button>
        </div>
      </main>
    </div>
  );
}

function Page({ api, route, me }: { api: AdminApi; route: Route; me: SessionUser }) {
  switch (route.page) {
    case "users":
      return <UsersView api={api} />;
    case "user":
      return <UserView key={route.id} api={api} userId={route.id} me={me} />;
    case "spaces":
      return <SpacesView api={api} />;
    case "space":
      return <SpaceView key={route.id} api={api} spaceId={route.id} />;
    case "library":
      return <LibraryView api={api} />;
    case "settings":
      return <SettingsView api={api} />;
    case "audit":
      return <AuditView api={api} />;
    default:
      return <OverviewView api={api} />;
  }
}
