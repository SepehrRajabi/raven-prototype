import { capabilitiesOf } from "@/lib/permissions";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, Hand, Loader2, LogOut, Settings, WifiOff } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { toast, Toaster } from "@/components/ui/toast";
import { callVoteHeadline } from "@/lib/callVote";
import { UpdatesSettingsPanel } from "@/components/updates/UpdatesSettings";
import { Island } from "./ravenv1/atoms";
import { DeviceDock } from "./ravenv1/DeviceDock";
import { writeLastVisited } from "./ravenv1/lastVisited";
import { Sidebar } from "./ravenv1/Sidebar";
import { SidebarResizeHandle } from "./ravenv1/SidebarResizeHandle";
import { readSidebarWidth, SIDEBAR_RAIL_WIDTH, useSidebarMaxWidth, writeSidebarWidth } from "./ravenv1/sidebarWidth";
import { BareTopBar, TopBar } from "./ravenv1/TopBar";
import { MainView } from "./ravenv1/views";
import { RoomKnockToasts } from "./ravenv1/RoomKnockToasts";
import { resolveTreeSettingsSection, TreeSettingsNav } from "./ravenv1/views/TreeSettingsView";
import type { RavenView } from "./ravenv1/state";
import { useRavenShellData } from "./ravenv1/useRavenShellData";
import { useRavenMediaAdapter } from "./ravenv1/useRavenMediaAdapter";
import { useNestEntry } from "./ravenv1/useNestEntry";
import { useEntryToasts } from "./ravenv1/useEntryToasts";
import { connectedPeerIds } from "@/lib/callArrivals";
import { useMessageNotifications } from "./ravenv1/useMessageNotifications";
import { useChat } from "./ravenv1/useChat";
import { audioCommands } from "@/lib/audio";
import { useRavenUpdater } from "@/lib/updater";
import { manageEventSubscription } from "@/lib/thumbnailToolbar";
import { subscribeTrayActions } from "@/lib/tray";
import type { RavenUpdater } from "@/lib/updater";
import type { RavenShellData } from "./ravenv1/state";
import type { RavenMediaAdapterState } from "./ravenv1/useRavenMediaAdapter";
import { resolveUserSettingsSection, UserSettingsNav, UserSettingsView, type UserSettingsSection } from "./ravenv1/UserSettings";
import { api } from "@/lib/api";
import { accountsOffered } from "@/lib/invites";
import { ChoosePassword, ShellLogin } from "./ravenv1/SignIn";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { takeNestToRejoin } from "@/lib/crashRecovery";
import { RegionFallback } from "./ravenv1/RegionFallback";

export function RavenShellV1() {
  const [history, setHistory] = useState<{ entries: RavenView[]; index: number }>({ entries: [{ kind: "home" }], index: 0 });
  const [recoverySettings, setRecoverySettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem("raven.sidebarCollapsed") === "true");
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const sidebarMaxWidth = useSidebarMaxWidth();
  const shellGridRef = useRef<HTMLDivElement>(null);
  const wasUpdateRequired = useRef(false);
  const updater = useRavenUpdater();
  const data = useRavenShellData();
  const media = useRavenMediaAdapter(data.refresh, {
    alwaysJoinMuted: data.preferences.alwaysJoinMuted,
    joinWithCameraOff: data.preferences.joinWithCameraOff,
    joinWithoutScreenSharing: data.preferences.joinWithoutScreenSharing,
    nestLabel: data.labels.nestSingular,
    rtcServerUrl: data.serverProperties.rtcServerUrl,
    presenceState: data.presence?.state,
    presenceReachability: data.presence?.reachability,
    localUserId: data.user?.id,
  });
  const entry = useNestEntry(data.joinNest, media.joinMediaSession, media.cancelMediaJoin);
  const leaveCall = media.leaveMediaSession;
  const leaveFromFallback = media.activeNestId ? () => void leaveCall().catch(() => undefined) : undefined;
  const chat = useChat(data);
  const pendingCallFlow = data.pending.some((item) => item.kind === "knock");

  // Signing out ends the call. Whichever control signed the user out, the native media
  // session must not keep running (and keep a microphone published) behind the sign-in
  // screen.
  const signedIn = Boolean(data.user);
  useEffect(() => {
    if (signedIn || !media.activeNestId) return;
    void media.leaveMediaSession().catch(() => undefined);
  }, [signedIn, media.activeNestId, media.leaveMediaSession]);

  // The page was reloaded in the middle of a call (it failed to draw, or its WebView
  // process died; the call ended with it). Go back in, without the arrival heads-up:
  // the others saw this person drop a moment ago.
  const readyToRejoin = signedIn && !data.loading && !updater.loading && !updater.updateRequired;
  const joinNestForRejoin = data.joinNest;
  const joinMediaForRejoin = media.joinMediaSession;
  useEffect(() => {
    if (!readyToRejoin) return;
    const nestId = takeNestToRejoin();
    if (!nestId) return;
    void (async () => {
      try {
        if ((await joinNestForRejoin(nestId)) !== "joined") return;
        await joinMediaForRejoin(nestId);
        toast({ title: "Raven reopened its window and joined your call again" });
      } catch {
        // A failed join is reported by the shell data and the media adapter.
      }
    })();
  }, [readyToRejoin, joinNestForRejoin, joinMediaForRejoin]);

  // Heads-up for the room this client is in: a short chime per arrival.
  const activeEntryNotices = useMemo(
    () => data.entryNotices.filter((notice) => notice.nestId === media.activeNestId),
    [data.entryNotices, media.activeNestId],
  );
  const chimedNoticesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const current = new Set(activeEntryNotices.map((notice) => `${notice.actorId}:${notice.receivedAt}`));
    for (const key of current) {
      if (chimedNoticesRef.current.has(key)) continue;
      void audioCommands.playUiSound("knock").catch(() => undefined);
    }
    chimedNoticesRef.current = current;
  }, [activeEntryNotices]);
  // The toast keeps people inside told until the joiner is really here: the same
  // "connected" the room view and the overlay use.
  const activeSession = media.activeNestId ? data.getActiveSession(media.activeNestId) : null;
  const activeConnectedPeers = useMemo(
    () => connectedPeerIds({ session: activeSession, audioState: media.audioState, videoState: media.videoState }),
    [activeSession, media.audioState, media.videoState],
  );
  const entryToasts = useEntryToasts(activeEntryNotices, activeConnectedPeers);
  const view = history.entries[history.index] ?? { kind: "home" };
  useMessageNotifications(chat, data, view);
  // Home's "Pick up" and the order of its trees come from the last nest and tree looked at.
  const signedInId = data.user?.id;
  useEffect(() => {
    if (!signedInId) return;
    if (view.kind === "nest") writeLastVisited(signedInId, { nestId: view.id });
    else if (view.kind === "tree") writeLastVisited(signedInId, { treeId: view.id });
  }, [signedInId, view]);
  // The stage shows a vote. Looking at something else, you still have to hear of it.
  const callVote = media.callVote.vote;
  const callVoteElsewhere = callVote?.outcome === "open" && !(view.kind === "nest" && view.id === callVote.nestId);
  const callVoteHeadlineText = callVote ? callVoteHeadline(callVote, data.user?.id) : "";
  useEffect(() => {
    if (callVoteElsewhere) toast({ title: callVoteHeadlineText, description: "Open the call to see it." });
  }, [callVote?.id, callVoteElsewhere]); // eslint-disable-line react-hooks/exhaustive-deps
  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.entries.length - 1;

  useEffect(() => {
    setHistory({ entries: [{ kind: "home" }], index: 0 });
  }, [data.user?.id]);

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener("contextmenu", disableContextMenu);
    return () => window.removeEventListener("contextmenu", disableContextMenu);
  }, []);

  // A failed action never replaces what the user is looking at. It is said
  // once, off to the side, and the view stays where it was.
  const loaded = Boolean(data.home);
  useEffect(() => {
    if (!data.error || !loaded || !signedIn) return;
    toast({ title: data.error, tone: "error" });
  }, [data.error, loaded, signedIn]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      localStorage.setItem("raven.sidebarCollapsed", String(next));
      return next;
    });
  }, []);

  const setSidebarRail = useCallback((collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    localStorage.setItem("raven.sidebarCollapsed", String(collapsed));
  }, []);

  const commitSidebarSize = useCallback(
    ({ width, collapsed }: { width: number; collapsed: boolean }) => {
      setSidebarRail(collapsed);
      if (collapsed) return;
      setSidebarWidth(width);
      writeSidebarWidth(width);
    },
    [setSidebarRail],
  );

  useEffect(() => {
    if (updater.loading) return;
    const captureActive = media.screenShareStatus === "live" || media.windowSharing || media.appAudioCapturing || media.cameraStatus === "live" || media.localMicEnabled;
    const transitionActive = media.phase === "joining" || media.phase === "leaving";
    const active = Boolean(media.activeNestId || media.busy || data.busy || captureActive || transitionActive || pendingCallFlow);
    const reason = media.activeNestId
      ? `an active ${data.labels.nestSingular} is connected`
      : transitionActive
        ? `a ${data.labels.nestSingular} connection is changing`
        : pendingCallFlow
          ? "an incoming or outgoing call flow is waiting"
        : captureActive
          ? "camera, microphone, screen, or app-audio capture is active"
          : media.busy
            ? "a sensitive device operation is in progress"
            : "";
    void updater.setBusy(active, reason);
  }, [
    updater.loading,
    media.activeNestId,
    media.busy,
    media.phase,
    media.screenShareStatus,
    media.windowSharing,
    media.appAudioCapturing,
    media.cameraStatus,
    media.localMicEnabled,
    data.busy,
    pendingCallFlow,
    data.labels.nestSingular,
    updater.setBusy,
  ]);

  // Ask the chosen server whether it still accepts this version of Raven.
  useEffect(() => {
    void updater.checkCompatibility().catch(() => undefined);
  }, [data.apiServerUrl, updater.checkCompatibility]);

  // Once the server accepts this version again, load what was held back.
  useEffect(() => {
    const required = Boolean(updater.updateRequired);
    if (wasUpdateRequired.current && !required && data.user) {
      void data.refresh().catch(() => undefined);
    }
    wasUpdateRequired.current = required;
  }, [updater.updateRequired, data.user, data.refresh]);

  const navigate = useCallback(
    (next: RavenView) => {
      setHistory((current) => {
        const active = current.entries[current.index] ?? { kind: "home" };
        if (viewKey(active) === viewKey(next)) {
          // Same place, different section (a settings category): stay on this history entry.
          const entries = [...current.entries];
          entries[current.index] = next;
          return { entries, index: current.index };
        }
        const entries = [...current.entries.slice(0, current.index + 1), next];
        return { entries, index: entries.length - 1 };
      });
    },
    [],
  );

  // "Settings" and "Check for updates" in the tray menu. The window is already brought
  // forward natively; this opens the page.
  const checkForUpdates = updater.checkNow;
  useEffect(() => manageEventSubscription(
    () => subscribeTrayActions((event) => {
      if (event.action === "settings") navigate({ kind: "settings" });
      if (event.action === "checkUpdates") {
        navigate({ kind: "settings", section: "updates" });
        void checkForUpdates();
      }
    }),
    () => undefined,
  ), [checkForUpdates, navigate]);

  const goBack = useCallback(() => {
    setHistory((current) => (current.index > 0 ? { ...current, index: current.index - 1 } : current));
  }, []);

  const goForward = useCallback(() => {
    setHistory((current) => (current.index < current.entries.length - 1 ? { ...current, index: current.index + 1 } : current));
  }, []);

  /** Leave the current view: back to where the user came from, or Home. */
  const leaveView = useCallback(() => {
    setHistory((current) =>
      current.index > 0
        ? { ...current, index: current.index - 1 }
        : { entries: [{ kind: "home" }], index: 0 },
    );
  }, []);

  const navigation = useMemo(
    () => ({ canGoBack, canGoForward, goBack, goForward, navigate, leaveView }),
    [canGoBack, canGoForward, goBack, goForward, navigate, leaveView],
  );

  const toggleMixer = useCallback(() => {
    if (view.kind === "mixer") leaveView();
    else navigate({ kind: "mixer" });
  }, [leaveView, navigate, view.kind]);

  if (data.loading || updater.loading) {
    return (
      <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <BareTopBar />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex items-center gap-2.5 text-small text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" />
            Opening Raven…
          </div>
        </div>
      </div>
    );
  }

  if (updater.updateRequired) {
    return (
      <UpdateRecoveryShell
        data={data}
        media={media}
        updater={updater}
        showSettings={recoverySettings}
        onShowSettings={setRecoverySettings}
      />
    );
  }

  if (!data.user) {
    if (data.passwordChangeRequired) {
      return (
        <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <BareTopBar />
          <ChoosePassword onChange={data.changePassword} onLogout={data.logout} />
        </div>
      );
    }
    if (data.serverUnreachable) {
      return <ServerUnreachable busy={data.busy} serverUrl={data.apiServerUrl} onRetry={data.retryConnection} onLogout={data.logout} />;
    }
    return (
      <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <BareTopBar />
        <ShellLogin
          busy={data.busy}
          error={data.error}
          notice={data.notice}
          serverName={data.serverProperties.name}
          serverDescription={data.serverProperties.description}
          serverAvatar={data.serverProperties.avatar}
          apiServerUrl={data.apiServerUrl}
          apiServerHistory={data.apiServerHistory}
          onServerSelect={data.selectApiServer}
          accounts={accountsOffered(data.serverProperties)}
          onLogin={data.login}
          savedAccounts={data.savedAccounts}
          onSwitchAccount={data.switchAccount}
          onSignUp={data.signUp}
        />
      </div>
    );
  }

  const treeSettingsDetails = view.kind === "tree-settings" ? data.getTreeDetails(view.id) : undefined;
  const inSettings = view.kind === "settings" || Boolean(treeSettingsDetails);
  const railCollapsed = sidebarCollapsed && !inSettings;
  const effectiveSidebarWidth = Math.min(sidebarWidth, sidebarMaxWidth);

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <ErrorBoundary name="title bar" fallback={() => <BareTopBar />}>
        <TopBar
          data={data}
          onNavigate={navigation.navigate}
          canGoBack={navigation.canGoBack}
          canGoForward={navigation.canGoForward}
          onBack={navigation.goBack}
          onForward={navigation.goForward}
          update={updater.state}
        />
      </ErrorBoundary>

      <div
        ref={shellGridRef}
        className="relative grid min-h-0 flex-1 grid-cols-[var(--sidebar-w)_minmax(0,1fr)] pr-2"
        style={{ "--sidebar-w": `${railCollapsed ? SIDEBAR_RAIL_WIDTH : effectiveSidebarWidth}px` } as CSSProperties}
      >
        <ErrorBoundary name="sidebar" resetKey={viewKey(view)} fallback={(retry) => <RegionFallback compact onRetry={retry} />}>
        {view.kind === "settings" ? (
          <UserSettingsNav
            section={resolveUserSettingsSection(view.section, Boolean(capabilitiesOf(data.user).createInvites))}
            canInvite={Boolean(capabilitiesOf(data.user).createInvites)}
            labels={data.labels}
            onSelect={(section) => navigation.navigate({ kind: "settings", section })}
            onBack={navigation.leaveView}
          />
        ) : view.kind === "tree-settings" && treeSettingsDetails ? (
          <TreeSettingsNav
            details={treeSettingsDetails}
            data={data}
            section={resolveTreeSettingsSection(view.section, treeSettingsDetails, data)}
            onSelect={(section) => navigation.navigate({ kind: "tree-settings", id: view.id, section })}
            onBack={() => navigation.navigate({ kind: "tree", id: view.id })}
          />
        ) : (
          <Sidebar
            view={view}
            data={data}
            media={media}
            entry={entry}
            chat={chat}
            collapsed={sidebarCollapsed}
            onToggle={toggleSidebar}
            onNavigate={navigation.navigate}
          />
        )}
        </ErrorBoundary>
        <Island className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <ErrorBoundary name={`view ${view.kind}`} resetKey={viewKey(view)} fallback={(retry) => <RegionFallback onRetry={retry} />}>
          <MainView
            view={view}
            data={data}
            media={media}
            entry={entry}
            updater={updater}
            chat={chat}
            onNavigate={navigation.navigate}
            onBack={navigation.leaveView}
          />
          </ErrorBoundary>
        </Island>
        <SidebarResizeHandle
          target={shellGridRef}
          width={effectiveSidebarWidth}
          maxWidth={sidebarMaxWidth}
          collapsed={railCollapsed}
          canCollapse={!inSettings}
          onCollapsedChange={setSidebarRail}
          onCommit={commitSidebarSize}
        />
      </div>

      <ErrorBoundary name="arrival notices" fallback={() => null}>
      {entryToasts.length > 0 ? (
        <div className="pointer-events-none fixed bottom-[76px] left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
          {entryToasts.map(({ notice, phase }) => (
            <div
              key={`${notice.actorId}:${notice.receivedAt}`}
              className="flex animate-pop-in items-center gap-2.5 rounded-full bg-popover py-1.5 pl-1.5 pr-4 text-small text-popover-foreground shadow-raised"
            >
              <Avatar name={notice.actorName} src={api.userAvatarUrl(notice.actorId)} className="h-6 w-6" />
              <span>
                <span className="font-medium">{notice.actorName}</span> {phase === "connecting" ? "is connecting…" : "is about to join"}
              </span>
              {phase === "connecting" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Hand className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </div>
          ))}
        </div>
      ) : null}
      </ErrorBoundary>

      <ErrorBoundary name="dock" fallback={(retry) => <RegionFallback compact onRetry={retry} onLeave={leaveFromFallback} />}>
        <DeviceDock data={data} media={media} chat={chat} view={view} onNavigate={navigation.navigate} onToggleMixer={toggleMixer} />
      </ErrorBoundary>
      <RoomKnockToasts data={data} media={media} />
      <Toaster />
    </div>
  );
}

function UpdateRecoveryShell({
  data,
  media,
  updater,
  showSettings,
  onShowSettings,
}: {
  data: RavenShellData;
  media: RavenMediaAdapterState;
  updater: RavenUpdater;
  showSettings: boolean;
  onShowSettings: (value: boolean) => void;
}) {
  const [section, setSection] = useState<UserSettingsSection>("updates");
  const [sidebarWidth] = useState(readSidebarWidth);
  const sidebarMaxWidth = useSidebarMaxWidth();

  if (showSettings && data.user) {
    return (
      <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <BareTopBar />
        <div
          className="grid min-h-0 flex-1 grid-cols-[var(--sidebar-w)_minmax(0,1fr)] pb-2 pr-2"
          style={{ "--sidebar-w": `${Math.min(sidebarWidth, sidebarMaxWidth)}px` } as CSSProperties}
        >
          <UserSettingsNav section={section} canInvite={false} labels={data.labels} onSelect={setSection} onBack={() => onShowSettings(false)} />
          <Island className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <UserSettingsView section={section} data={data} media={media} updater={updater} />
          </Island>
        </div>
        <Toaster className="bottom-4" />
      </div>
    );
  }

  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <Island className="mx-auto min-h-full w-full max-w-[760px] px-8 py-8">
          <div className="space-y-8">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-warning/10 text-warning">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="text-title font-semibold">Raven needs an update</h1>
                <p className="mt-1 text-body text-muted-foreground">
                  {updater.updateRequired?.message || "This version of Raven is too old for this server."}
                </p>
                <p className="mt-3 text-small text-muted-foreground">
                  While paused, Raven will not join a {data.labels.nestSingular.toLowerCase()} or send any audio or video. It will not restart unless you choose to.
                  Your data on this device stays where it is.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="secondary" size="sm" onClick={() => void updater.checkCompatibility().catch(() => undefined)}>
                  Try again
                </Button>
                {data.user ? (
                  <Button variant="secondary" size="sm" onClick={() => onShowSettings(true)}>
                    <Settings className="h-4 w-4" />
                    Settings
                  </Button>
                ) : null}
                {data.user ? (
                  <Button variant="ghost" size="sm" onClick={data.logout}>
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </Button>
                ) : null}
              </div>
            </div>

            {media.activeNestId ? (
              <div className="rounded-card bg-secondary/60 p-4">
                <div className="text-body font-medium">You are still in your {data.labels.nestSingular.toLowerCase()}</div>
                <p className="mt-1 text-small text-muted-foreground">
                  The call was not interrupted. Raven can only restart to update after you leave. Updating never turns on your camera, microphone or screen sharing.
                </p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  size="sm"
                  disabled={media.busy}
                  onClick={() => void media.leaveMediaSession()}
                >
                  Leave the {data.labels.nestSingular.toLowerCase()}
                </Button>
              </div>
            ) : null}

            <UpdatesSettingsPanel updater={updater} />
          </div>
        </Island>
      </div>
    </div>
  );
}

function ServerUnreachable({
  busy,
  serverUrl,
  onRetry,
  onLogout,
}: {
  busy: boolean;
  serverUrl: string;
  onRetry: () => Promise<void>;
  onLogout: () => void;
}) {
  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <BareTopBar />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[380px] text-center">
          <WifiOff className="mx-auto h-6 w-6 text-subtle" />
          <h1 className="mt-4 text-title font-semibold">Can’t reach your server</h1>
          <p className="mt-1.5 text-body text-muted-foreground">
            Raven could not connect. You are still signed in on this device, and it will pick up where you left off.
          </p>
          <p className="rv-mono mt-3 break-all text-caption text-subtle">{serverUrl}</p>
          <div className="mt-6 flex justify-center gap-2">
            <Button disabled={busy} onClick={() => void onRetry()}>{busy ? "Trying…" : "Try again"}</Button>
            <Button variant="ghost" disabled={busy} onClick={onLogout}>Sign out</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function viewKey(view: RavenView) {
  switch (view.kind) {
    case "home":
    case "settings":
    case "mixer":
    case "licences":
      return view.kind;
    case "tree-preview":
      return `${view.kind}:${view.result.tree.id}`;
    default:
      return `${view.kind}:${view.id}`;
  }
}
