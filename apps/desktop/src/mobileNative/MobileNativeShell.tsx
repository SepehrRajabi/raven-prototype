import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { ChevronUp, Headphones, HeadphoneOff, Home, Loader2, MessageSquare, Mic, MicOff, PhoneOff, Settings, SlidersHorizontal, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toaster, toast } from "@/components/ui/toast";
import { api, subscribeUpdateRequired } from "@/lib/api";
import { accountsOffered } from "@/lib/invites";
import { callVoteHeadline } from "@/lib/callVote";
import type { RavenUpdater } from "@/lib/updater";
import { CameraMenu, MicMenu, OutputMenu } from "@/shells/ravenv1/DeviceDock";
import type { RavenShellData, RavenView } from "@/shells/ravenv1/state";
import type { RavenMediaAdapterState } from "@/shells/ravenv1/useRavenMediaAdapter";
import { useMessageNotifications } from "@/shells/ravenv1/useMessageNotifications";
import { MainView } from "@/shells/ravenv1/views";
import { RoomKnockToasts } from "@/shells/ravenv1/RoomKnockToasts";
import { ChoosePassword, ShellLogin } from "@/shells/ravenv1/SignIn";
import { createMobileNativeCallHost } from "./callHost";
import { mobileNativeCommands } from "./media";
import { useMobileNativeNavigation } from "./navigation";
import { useMobileNativeApp } from "./useMobileNativeApp";

/** The MobileNative layout over the same app, chat, entry and call owners as desktop.
 * Views shared with desktop are reused until a screen needs its own mobile design;
 * that screen then moves into this folder. */
export function MobileNativeShell() {
  const [callHost] = useState(createMobileNativeCallHost);
  const { data, media, entry, chat, activeEntryNotices } = useMobileNativeApp(callHost);
  const updater = useServerCompatibility();

  // Marks the document for Android-only styles without a module-level side effect.
  useLayoutEffect(() => {
    document.body.dataset.platform = "android";
  }, []);

  // There is no in-app installer here, but the server can still refuse old clients.
  useEffect(() => {
    void updater.checkCompatibility().catch(() => undefined);
  }, [data.apiServerUrl, updater.checkCompatibility]);

  if (data.loading) {
    return (
      <MobileNativeScreen>
        <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" aria-label="Opening Raven" /></div>
      </MobileNativeScreen>
    );
  }
  if (!data.user) return <SignedOut data={data} />;
  if (updater.updateRequired) {
    return (
      <MobileNativeScreen>
        <main className="m-auto max-w-sm p-6 text-center">
          <h1 className="text-title font-semibold">Raven needs an update</h1>
          <p className="mt-2 text-small text-muted-foreground">
            {updater.updateRequired.message || "This version of Raven is too old for this server."}
          </p>
          <Button className="mt-4" variant="secondary" onClick={() => void updater.checkCompatibility()}>Try again</Button>
          <Toaster />
        </main>
      </MobileNativeScreen>
    );
  }

  // Keyed by user so each signed-in user starts at Home.
  return <SignedInApp key={data.user.id} data={data} media={media} entry={entry} chat={chat} updater={updater} activeEntryNotices={activeEntryNotices} />;
}

type SignedInAppProps = Pick<ReturnType<typeof useMobileNativeApp>, "data" | "media" | "entry" | "chat" | "activeEntryNotices"> & { updater: RavenUpdater };

/** The signed-in layout and its Back stack. */
function SignedInApp({ data, media, entry, chat, updater, activeEntryNotices }: SignedInAppProps) {
  const { view, navigation } = useMobileNativeNavigation();
  useMessageNotifications(chat, data, view);

  // System Back walks the in-app history while there is somewhere to go back to.
  useEffect(() => {
    if (!navigation.canGoBack) return;
    const listener = onBackButtonPress(navigation.goBack);
    void listener.catch((error: unknown) => toast({ title: "System Back is unavailable", description: String(error), tone: "error" }));
    return () => {
      void listener.then((subscription) => subscription.unregister()).catch(() => undefined);
    };
  }, [navigation.canGoBack, navigation.goBack]);

  // Looking at something else, you still have to hear of a vote in the call.
  const vote = media.callVote.vote;
  const voteElsewhere = vote?.outcome === "open" && !(view.kind === "nest" && view.id === vote.nestId);
  const voteHeadline = vote ? callVoteHeadline(vote, data.user?.id) : "";
  useEffect(() => {
    if (voteElsewhere) toast({ title: voteHeadline, description: "Open the call to see it." });
  }, [vote?.id, voteElsewhere]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="ravenv1-scope flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center px-4 text-body font-semibold">{data.serverProperties.name || "Raven"}</header>
      <MediaErrorBanner media={media} />
      <main className="min-h-0 flex-1 px-2 pb-1">
        <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-card bg-surface">
          <MainView view={view} data={data} media={media} entry={entry} updater={updater} chat={chat} onNavigate={navigation.navigate} onBack={navigation.goBack} />
        </div>
      </main>
      <nav className="grid shrink-0 grid-cols-3 gap-1 px-2 pb-1" aria-label="Main navigation">
        <Button variant={view.kind === "home" ? "secondary" : "ghost"} onClick={() => navigation.navigate({ kind: "home" })}>
          <Home className="h-4 w-4" />Home
        </Button>
        <Button variant={view.kind === "messages" || view.kind === "chat" ? "secondary" : "ghost"} onClick={() => navigation.navigate({ kind: "messages" })}>
          <MessageSquare className="h-4 w-4" />Messages
        </Button>
        <Button variant={view.kind === "settings" ? "secondary" : "ghost"} onClick={() => navigation.navigate({ kind: "settings" })}>
          <Settings className="h-4 w-4" />Settings
        </Button>
      </nav>
      {media.activeNestId ? <CallControls media={media} onNavigate={navigation.navigate} /> : null}
      <RoomKnockToasts data={data} media={media} />
      {activeEntryNotices.length ? <div className="sr-only" role="status" aria-live="polite">{activeEntryNotices.length} people are joining</div> : null}
      <Toaster />
    </div>
  );
}

/** A whole-screen state before the signed-in app: loading, sign-in, or a blocking problem. */
function MobileNativeScreen({ children }: { children: ReactNode }) {
  return (
    <div className="ravenv1-scope flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 px-4 py-3 font-semibold">Raven</header>
      {children}
    </div>
  );
}

/** Nobody is signed in: a required password change, an unreachable server, or sign-in. */
function SignedOut({ data }: { data: RavenShellData }) {
  if (data.passwordChangeRequired) {
    return <MobileNativeScreen><ChoosePassword onChange={data.changePassword} onLogout={data.logout} /></MobileNativeScreen>;
  }
  if (data.serverUnreachable) {
    return (
      <MobileNativeScreen>
        <div className="m-auto max-w-sm p-6 text-center">
          <h1 className="text-title font-semibold">Can’t reach your server</h1>
          <p className="mt-2 break-all text-small text-muted-foreground">{data.apiServerUrl}</p>
          <Button className="mt-4" disabled={data.busy} onClick={() => void data.retryConnection()}>Try again</Button>
          <Button className="mt-2" variant="ghost" onClick={data.logout}>Sign out</Button>
        </div>
      </MobileNativeScreen>
    );
  }
  return (
    <MobileNativeScreen>
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
      <Toaster />
    </MobileNativeScreen>
  );
}

/** A media failure, with a way to the OS permission page when that is the cause. */
function MediaErrorBanner({ media }: { media: RavenMediaAdapterState }) {
  if (!media.error) return null;
  const openPermissions = async () => {
    await media.leaveMediaSession();
    await mobileNativeCommands.openSettings();
  };
  return (
    <div role="alert" className="shrink-0 px-4 py-2 text-small text-muted-foreground">
      <p>{media.error}</p>
      {media.lastError?.kind === "permission_denied" ? (
        <Button
          variant="ghost"
          className="mt-1"
          onClick={() => void openPermissions().catch((error: unknown) => toast({ title: "Could not open app permissions", description: String(error), tone: "error" }))}
        >
          {media.activeNestId ? "Leave call and open app permissions" : "Open app permissions"}
        </Button>
      ) : null}
    </div>
  );
}

/** Call controls stay on screen through every view while a call is active. */
function CallControls({ media, onNavigate }: { media: RavenMediaAdapterState; onNavigate: (view: RavenView) => void }) {
  const micOn = media.localMicEnabled && !media.localServerMuted;
  const deafened = media.localDeafened || media.localServerDeafened;
  const cameraOn = media.localCameraEnabled;
  const micLabel = media.localServerMuted ? "Muted by a moderator" : micOn ? "Mute microphone" : "Unmute microphone";
  const deafenLabel = media.localServerDeafened ? "Deafened by a moderator" : deafened ? "Undeafen" : "Deafen";
  return (
    <footer className="shrink-0 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1" aria-label="Call controls">
      <div className="flex items-center justify-center gap-1.5">
        <div className="inline-flex items-center">
          <Button size="icon" className="rounded-r-none" variant={micOn ? "secondary" : "destructive"} aria-label={micLabel} title={micLabel} disabled={media.localServerMuted || !media.audioSupported || media.busy} onClick={() => void media.toggleMic()}>
            {micOn ? <Mic /> : <MicOff />}
          </Button>
          <MenuChevron label="Microphone options" menu={<MicMenu media={media} />} />
        </div>
        <div className="inline-flex items-center">
          <Button size="icon" className="rounded-r-none" variant={deafened ? "destructive" : "secondary"} aria-label={deafenLabel} title={deafenLabel} disabled={media.localServerDeafened || !media.deafenSupported || media.busy} onClick={() => void media.toggleDeafen()}>
            {deafened ? <HeadphoneOff /> : <Headphones />}
          </Button>
          <MenuChevron label="Output options" menu={<OutputMenu media={media} />} />
        </div>
        <div className="inline-flex items-center">
          <Button size="icon" className="rounded-r-none" variant={cameraOn ? "secondary" : "ghost"} aria-label={cameraOn ? "Turn camera off" : "Turn camera on"} disabled={!media.cameraSupported || media.busy} onClick={() => void media.toggleCamera()}>
            {cameraOn ? <Video /> : <VideoOff />}
          </Button>
          <MenuChevron label="Camera options" menu={<CameraMenu media={media} />} />
        </div>
        <Button size="icon" variant="ghost" aria-label="Mixer" title="Mixer" onClick={() => onNavigate({ kind: "mixer" })}>
          <SlidersHorizontal />
        </Button>
        <Button size="icon" variant="destructive" aria-label="Leave call" disabled={media.busy} onClick={() => void media.leaveMediaSession()}>
          <PhoneOff />
        </Button>
      </div>
    </footer>
  );
}

/** A compact chevron attached to a call button that opens its device menu above it. */
function MenuChevron({ label, menu }: { label: string; menu: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="secondary" className="h-9 w-6 rounded-l-none border-l border-background/60" aria-label={label} title={label}>
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-[min(360px,calc(100vw-2rem))] p-2">{menu}</PopoverContent>
    </Popover>
  );
}

const noUpdaterCommand = async () => undefined;

/** The shared views' updater without the desktop installer: Android apps update through
 * their store or APK, but the server can still refuse an old client. */
function useServerCompatibility(): RavenUpdater {
  const [updateRequired, setUpdateRequired] = useState(() => api.getUpdateRequired());
  useEffect(() => subscribeUpdateRequired(setUpdateRequired), []);
  const checkCompatibility = useCallback(async () => {
    await api.checkCompatibility();
  }, []);
  return useMemo(() => ({
    state: null,
    loading: false,
    error: "",
    updateRequired,
    checkNow: noUpdaterCommand,
    download: noUpdaterCommand,
    install: noUpdaterCommand,
    setBusy: noUpdaterCommand,
    checkCompatibility,
  }), [updateRequired, checkCompatibility]);
}
