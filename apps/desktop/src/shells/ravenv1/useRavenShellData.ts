import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, HomeState, isTransientNestUpdate, isUnauthorizedError, LauncherNest, NestDetails, NestLiveUpdate, PublicUser, ServerProperties, SessionSummary, SignUpRequest, TreeDetails, TreeJoinPolicy, TreeRole, TreeSearchResult, TreeVisibility } from "@/lib/api";
import type { SavedAccount } from "@/lib/accounts";
import { audioCommands } from "@/lib/audio";
import { clearAvatarVersions, noteAvatarVersion } from "@/lib/avatarVersions";
import { ENTRY_CONNECTING_TTL_MS } from "@/lib/callArrivals";
import { rememberActiveNest } from "@/lib/crashRecovery";
import { forgetUnsentMessages } from "@/lib/chat/outbox";
import { subscribeNestUpdates } from "@/lib/eventStream";
import { stopAllSessions } from "@/lib/workshop";
import { knockAge, loadNotificationSettings, newProfileKnocks, notificationCommands, type SeenKnocks } from "@/lib/notifications";
import type { NestEntryNotice, PendingItem, RavenShellData, SelectablePresence, ShellPerson, UILabelCopy } from "./state";
import { defaultPreferences, displayNameFor, labelsForPreference, presenceFromApi } from "./state";
import { ApiError, type KnockReply, type NestDoor, type ProfileKnockState } from "@/lib/api";
import { toast } from "@/components/ui/toast";
import { answerToast, answerUntil, knockAnswers, newKnockAnswers } from "./knockReplies";

/**
 * How long an entry notice is kept if it is neither cancelled nor replaced. The toast
 * itself goes as soon as the person is connected (`entryNoticePhase`).
 */
const ENTRY_NOTICE_TTL_MS = ENTRY_CONNECTING_TTL_MS;
/** Every this many presence heartbeats, also refresh the people shown from Trees. */
const TREE_PRESENCE_REFRESH_EVERY = 4;

/** Apply a live "someone is entering" update to the visible notices. */
export function applyEntryUpdate(
  notices: NestEntryNotice[],
  update: NestLiveUpdate,
  now: number,
): NestEntryNotice[] {
  if (!update.nestId || !update.actorId) return notices;
  const others = notices.filter(
    (notice) => !(notice.nestId === update.nestId && notice.actorId === update.actorId),
  );
  if (update.type !== "nest.entering") return others.length === notices.length ? notices : others;
  return [
    ...others,
    { nestId: update.nestId, actorId: update.actorId, actorName: update.actorName || "Someone", receivedAt: now },
  ];
}

/** The server refuses everything but a password change to an account on a temporary one. */
function isPasswordChangeRequired(error: unknown) {
  return error instanceof ApiError && error.reasonCode === "password_change_required";
}

function isNestGone(error: unknown) {
  return error instanceof ApiError && (error.status === 403 || error.status === 404 || error.status === 410);
}

function messageFromError(error: unknown, fallback = "Request failed") {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useRavenShellData(): RavenShellData {
  const [home, setHome] = useState<HomeState | null>(null);
  const [serverProperties, setServerProperties] = useState<ServerProperties>(api.fallbackServerProperties());
  const [apiServerUrl, setApiServerUrl] = useState(api.getBaseUrl());
  const [apiServerHistory, setApiServerHistory] = useState(api.getServerHistory());
  const [savedAccounts, setSavedAccounts] = useState(api.savedAccounts());
  const [treeDetails, setTreeDetails] = useState<Record<string, TreeDetails>>({});
  const [nestDetails, setNestDetails] = useState<Record<string, NestDetails>>({});
  const [activeSessions, setActiveSessions] = useState<Record<string, SessionSummary | null>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Told once on the sign-in screen, then gone with the next attempt.
  const [notice, setNotice] = useState("");
  const [serverUnreachable, setServerUnreachable] = useState(false);
  const [passwordChangeRequired, setPasswordChangeRequired] = useState(false);
  const [entryNotices, setEntryNotices] = useState<NestEntryNotice[]>([]);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  // Home is fetched from several places at once (live events, the heartbeat, a refresh
  // after an action). Each fetch takes a ticket when it starts, and a reply is dropped if a
  // fetch that started later has already been applied, so an older snapshot never
  // replaces a newer one.
  const homeFetchRef = useRef({ started: 0, applied: 0 });
  const authenticated = home !== null && Boolean(api.getSessionId());
  // Profile knocks already accounted for on this device; signing out forgets them.
  const seenKnocksRef = useRef<SeenKnocks | null>(null);
  // Answers to knocks this user sent, already accounted for here, and the ones cleared.
  const seenAnswersRef = useRef<SeenKnocks | null>(null);
  const [clearedAnswers, setClearedAnswers] = useState<ReadonlySet<string>>(() => new Set());

  // A new profile knock becomes a notification when the user asked for one and is not
  // in Do not disturb. Whether Raven is in front is decided natively, beside the window.
  useEffect(() => {
    if (!home) return;
    const { seen, fresh } = newProfileKnocks(seenKnocksRef.current, home.user.id, home.pendingKnocks);
    seenKnocksRef.current = seen;
    if (fresh.length === 0 || home.presence?.state === "dnd") return;
    // One soft knock however many arrived; the sound cue settings decide whether it plays.
    void audioCommands.playSoundCue("profileKnock").catch(() => undefined);
    if (!loadNotificationSettings().knocks) return;
    for (const knock of fresh) {
      void notificationCommands.notifyKnock(knock.fromDisplayName || knock.fromUsername, `Knocked ${knockAge(knock.createdAt, Date.now())}`).catch(() => undefined);
    }
  }, [home]);

  // An answer to a knock you sent reaches you as a notification only under the same
  // Knocks switch, and never in Do not disturb.
  useEffect(() => {
    if (!home) return;
    const { seen, fresh } = newKnockAnswers(seenAnswersRef.current, home.user.id, home.profileKnocks ?? [], Date.now());
    seenAnswersRef.current = seen;
    if (fresh.length === 0 || home.presence?.state === "dnd" || !loadNotificationSettings().knocks) return;
    for (const answer of fresh) void notificationCommands.notifyKnock(answer.name, answer.line).catch(() => undefined);
  }, [home]);

  const hydrateTrees = useCallback(async (nextHome: HomeState) => {
    const entries = await Promise.all(
      nextHome.trees.map(async (tree) => {
        try {
          return [tree.id, await api.getTree(tree.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    setTreeDetails(Object.fromEntries(entries.filter(Boolean) as Array<readonly [string, TreeDetails]>));
  }, []);

  const hydrateNests = useCallback(async (nextHome: HomeState) => {
    const nestIds = new Set<string>();
    for (const nest of [...nextHome.activeNests, ...nextHome.temporaryNests]) nestIds.add(nest.id);
    for (const invite of nextHome.pendingInvites) nestIds.add(invite.nestId);
    for (const request of nextHome.pendingRequests) nestIds.add(request.nestId);
    for (const knock of nextHome.pendingKnocks) if (knock.nestId) nestIds.add(knock.nestId);

    const detailEntries = await Promise.all(
      [...nestIds].map(async (nestId) => {
        try {
          return [nestId, await api.getNest(nestId)] as const;
        } catch {
          return null;
        }
      }),
    );
    setNestDetails(Object.fromEntries(detailEntries.filter(Boolean) as Array<readonly [string, NestDetails]>));

    const sessionEntries = await Promise.all(
      [...nestIds].map(async (nestId) => {
        try {
          const result = await api.activeSession(nestId);
          return [nestId, result.session] as const;
        } catch {
          return [nestId, null] as const;
        }
      }),
    );
    setActiveSessions(Object.fromEntries(sessionEntries));
  }, []);

  const refreshServerProperties = useCallback(async () => {
    let next: ServerProperties;
    try {
      const properties = await api.serverProperties();
      next = {
        ...api.fallbackServerProperties(),
        ...properties,
        properties: properties.properties ?? {},
      };
    } catch {
      next = api.fallbackServerProperties();
    }
    setServerProperties(next);
    setApiServerUrl(api.getBaseUrl());
    setApiServerHistory(api.getServerHistory());
    setSavedAccounts(api.savedAccounts());
    return next;
  }, []);

  /** Fetch home; null when a newer fetch has already been applied. */
  const fetchHome = useCallback(async () => {
    const fetches = homeFetchRef.current;
    const ticket = ++fetches.started;
    const nextHome = await api.home();
    if (ticket < fetches.applied) return null;
    fetches.applied = ticket;
    return nextHome;
  }, []);

  const refresh = useCallback(() => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const operation = (async () => {
      setError("");
      const properties = await refreshServerProperties();
      const nextHome = await fetchHome();
      setServerUnreachable(false);
      if (!nextHome) return;
      setHome(nextHome);
      api.rememberAccount(nextHome.user, properties.name);
      setSavedAccounts(api.savedAccounts());
      await Promise.all([hydrateTrees(nextHome), hydrateNests(nextHome)]);
    })();
    refreshPromiseRef.current = operation;
    const clearRefresh = () => {
      if (refreshPromiseRef.current === operation) refreshPromiseRef.current = null;
    };
    void operation.then(clearRefresh, clearRefresh);
    return operation;
  }, [fetchHome, hydrateNests, hydrateTrees, refreshServerProperties]);

  const refreshFriends = useCallback(async () => {
    const nextFriends = await api.friends();
    setHome((current) => current ? { ...current, ...nextFriends } : current);
  }, []);

  /** Someone came online or went offline: refresh who is where, not every Nest. */
  const refreshPresence = useCallback(async () => {
    const nextHome = await fetchHome();
    setServerUnreachable(false);
    if (!nextHome) return;
    setHome(nextHome);
    await hydrateTrees(nextHome);
  }, [fetchHome, hydrateTrees]);

  const refreshNestUpdates = useCallback(async (updates: NestLiveUpdate[]) => {
    const nestIds = [...new Set(updates.map((update) => update.nestId).filter((id): id is string => Boolean(id)))];
    if (nestIds.length === 0) return;

    const [homeResult, detailResults, sessionResults] = await Promise.all([
      fetchHome()
        .then((value) => ({ status: "fulfilled" as const, value }))
        .catch((reason: unknown) => ({ status: "rejected" as const, reason })),
      Promise.all(nestIds.map(async (nestId) => {
        try {
          return [nestId, await api.getNest(nestId), false] as const;
        } catch (err) {
          // The server refuses a nest that was ended or that this person no longer has
          // access to; a dropped connection says nothing about the nest itself.
          return [nestId, undefined, isNestGone(err)] as const;
        }
      })),
      Promise.all(nestIds.map(async (nestId) => {
        try {
          const result = await api.activeSession(nestId);
          return [nestId, result.session] as const;
        } catch {
          return [nestId, null] as const;
        }
      })),
    ]);

    if (homeResult.status === "rejected") throw homeResult.reason;
    if (homeResult.value) setHome(homeResult.value);
    setServerUnreachable(false);
    setNestDetails((current) => {
      const next = { ...current };
      detailResults.forEach(([nestId, details, isGone]) => {
        if (details) next[nestId] = details;
        else if (isGone) delete next[nestId];
      });
      return next;
    });
    setActiveSessions((current) => {
      const next = { ...current };
      sessionResults.forEach(([nestId, session]) => {
        next[nestId] = session;
      });
      return next;
    });

    const gone = detailResults.flatMap(([nestId, , isGone]) => (isGone ? [nestId] : []));
    const treeIds = new Set(detailResults.flatMap(([, details]) => details?.nest.treeId ? [details.nest.treeId] : []));
    // A nest that was ended has no details to name its tree, but the update does. Its tree
    // is fetched again so the nest leaves the list.
    for (const update of updates) if (update.treeId && gone.includes(update.nestId ?? "")) treeIds.add(update.treeId);
    if (treeIds.size > 0) {
      const trees = await Promise.all([...treeIds].map(async (treeId) => {
        try {
          return [treeId, await api.getTree(treeId)] as const;
        } catch {
          return null;
        }
      }));
      setTreeDetails((current) => ({
        ...current,
        ...Object.fromEntries(trees.filter(Boolean) as Array<readonly [string, TreeDetails]>),
      }));
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const boot = async () => {
      const properties = await refreshServerProperties();
      if (!api.getSessionId()) {
        if (mounted) {
          setHome(null);
          setLoading(false);
        }
        return;
      }
      try {
        const nextHome = await api.home();
        if (!mounted) return;
        setHome(nextHome);
        // Startup is where an existing sign-in first joins the saved list.
        api.rememberAccount(nextHome.user, properties.name);
        setSavedAccounts(api.savedAccounts());
        await Promise.all([hydrateTrees(nextHome), hydrateNests(nextHome)]);
      } catch (err) {
        if (mounted) {
          setHome(null);
          if (isUnauthorizedError(err)) {
            api.clearSession();
            setSavedAccounts(api.savedAccounts());
            setError("Your session has expired. Sign in again.");
          } else if (isPasswordChangeRequired(err)) {
            setPasswordChangeRequired(true);
          } else {
            setServerUnreachable(true);
            setError("");
          }
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void boot();
    return () => {
      mounted = false;
    };
  }, [hydrateNests, hydrateTrees, refreshServerProperties]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;
    let beats = 0;

    const heartbeat = async () => {
      requestController = new AbortController();
      const controller = requestController;
      const timeout = window.setTimeout(() => controller.abort(), 8_000);
      const ticket = ++homeFetchRef.current.started;
      try {
        const [presenceResult, nextFriends] = await Promise.all([
          api.presenceHeartbeat(controller.signal, false),
          api.friends(),
        ]);
        if (cancelled) return;
        // The friends list is only as new as this heartbeat. If home has been fetched
        // since it started, that is newer: an answered request must not come back.
        const friendsAreCurrent = ticket > homeFetchRef.current.applied;
        setHome((current) => current ? {
          ...current,
          presence: presenceResult.presence,
          ...(friendsAreCurrent ? nextFriends : null),
        } : current);
        beats += 1;
        // Live events normally keep Tree members' presence current; this catches up if
        // an event was missed while the stream was reconnecting.
        if (beats % TREE_PRESENCE_REFRESH_EVERY === 0) await refreshPresence();
      } catch {
        // A later heartbeat or the live event stream will reconcile presence.
      } finally {
        window.clearTimeout(timeout);
        if (requestController === controller) requestController = null;
        if (!cancelled) timer = window.setTimeout(() => void heartbeat(), 15_000);
      }
    };

    void heartbeat();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
    };
  }, [authenticated, refreshFriends, refreshPresence]);

  // Tell the server this client is going away so others see it offline at once, rather
  // than after the heartbeat window lapses.
  useEffect(() => {
    if (!authenticated) return;
    const goodbye = () => {
      void api.presenceGoodbye().catch(() => undefined);
    };
    window.addEventListener("pagehide", goodbye);
    window.addEventListener("beforeunload", goodbye);
    return () => {
      window.removeEventListener("pagehide", goodbye);
      window.removeEventListener("beforeunload", goodbye);
    };
  }, [authenticated]);

  // Entry notices are momentary; drop each one after a few seconds.
  useEffect(() => {
    if (entryNotices.length === 0) return;
    const oldest = Math.min(...entryNotices.map((notice) => notice.receivedAt));
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - ENTRY_NOTICE_TTL_MS;
      setEntryNotices((current) => current.filter((notice) => notice.receivedAt > cutoff));
    }, Math.max(0, oldest + ENTRY_NOTICE_TTL_MS - Date.now()) + 20);
    return () => window.clearTimeout(timer);
  }, [entryNotices]);

  // Port shares belong to the account that started them: stop them whenever the signed-in
  // account changes, and at startup, where anything still running outlived its page.
  const signedInUserId = home?.user.id ?? "";
  useEffect(() => {
    stopAllSessions();
  }, [signedInUserId]);

  // The server stopped accepting this session while the app was open (it expired, or it
  // was signed out from another device). Same outcome as finding that out at startup.
  const sessionExpired = useCallback(() => {
    api.clearSession();
    setSavedAccounts(api.savedAccounts());
    seenKnocksRef.current = null;
    setServerUnreachable(false);
    setHome(null);
    setTreeDetails({});
    setNestDetails({});
    setActiveSessions({});
    setEntryNotices([]);
    setError("Your session has expired. Sign in again.");
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    let timer: number | null = null;
    let running = false;
    let broadRefreshQueued = false;
    let presenceRefreshQueued = false;
    const nestUpdates = new Map<string, NestLiveUpdate>();

    const schedule = () => {
      if (cancelled || running || timer !== null) return;
      timer = window.setTimeout(() => void flush(), 150);
    };

    const flush = async () => {
      timer = null;
      if (cancelled || running) return;
      running = true;
      const runBroadRefresh = broadRefreshQueued;
      const runPresenceRefresh = presenceRefreshQueued;
      broadRefreshQueued = false;
      presenceRefreshQueued = false;
      const updates = [...nestUpdates.values()];
      nestUpdates.clear();
      try {
        if (runBroadRefresh) await refresh();
        else {
          if (runPresenceRefresh) await refreshPresence();
          await refreshNestUpdates(updates);
        }
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      } finally {
        running = false;
        if (broadRefreshQueued || presenceRefreshQueued || nestUpdates.size > 0) schedule();
      }
    };

    const onUpdate = (update: NestLiveUpdate) => {
      if (isTransientNestUpdate(update)) {
        // A heads-up, not a change of stored state: show it, do not refetch anything.
        setEntryNotices((current) => applyEntryUpdate(current, update, Date.now()));
        return;
      }
      // Held by useCallVote. A tally changes nothing that needs fetching again.
      if (update.type === "call.vote") return;
      // Held by lib/workshop.ts. A shared port changes nothing that needs fetching again.
      if (update.type.startsWith("workshop.")) return;
      // Held by useMessageNotifications. The space's own "tree.updated" carries the change.
      if (update.type === "event.invited" || update.type === "event.reminder") return;
      if (update.type === "profile.avatar") {
        // Only the picture changed. Its new version swaps it wherever it is shown.
        if (update.actorId && update.at) noteAvatarVersion(update.actorId, update.at);
        return;
      }
      if (update.nestId) nestUpdates.set(update.nestId, update);
      else if (update.type === "presence.changed") presenceRefreshQueued = true;
      else broadRefreshQueued = true;
      schedule();
    };
    // The stream is shared with text chat, so re-running this effect does not drop it.
    const unsubscribe = subscribeNestUpdates(onUpdate, sessionExpired);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [authenticated, refresh, refreshNestUpdates, refreshPresence, sessionExpired]);

  const login = useCallback(
    async (username: string, password: string) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await api.login(username, password);
        await refresh();
      } catch (err) {
        if (isPasswordChangeRequired(err)) {
          setPasswordChangeRequired(true);
        } else {
          setError(messageFromError(err, "Login failed"));
        }
      } finally {
        setBusy(false);
        setLoading(false);
      }
    },
    [refresh],
  );

  const signUp = useCallback(
    async (request: SignUpRequest) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await api.signUp(request);
        await refresh();
      } catch (err) {
        setError(messageFromError(err, "The account could not be made"));
      } finally {
        setBusy(false);
        setLoading(false);
      }
    },
    [refresh],
  );

  // Forgets this sign-in and everything shown for it.
  const forgetSignIn = useCallback(() => {
    api.clearSession();
    setPasswordChangeRequired(false);
    forgetUnsentMessages(localStorage);
    clearAvatarVersions();
    seenKnocksRef.current = null;
    setServerUnreachable(false);
    setHome(null);
    setTreeDetails({});
    setNestDetails({});
    setActiveSessions({});
    setEntryNotices([]);
    setSavedAccounts(api.savedAccounts());
  }, []);

  const logout = useCallback(() => {
    // The request captures the session before it is cleared; the server marks the
    // account offline as part of signing out.
    void api.logout().catch(() => undefined);
    forgetSignIn();
  }, [forgetSignIn]);

  // The server deleted this account and ended every session, so there is nothing to sign
  // out of: forget it here and say so on the sign-in screen.
  const accountDeleted = useCallback((host: string) => {
    forgetSignIn();
    setNotice(`Your account on ${host} is deleted. You’re signed out everywhere.`);
  }, [forgetSignIn]);

  /** Per-server state is spread across module singletons, so switching reloads the page. */
  const switchAccount = useCallback((account: SavedAccount) => {
    api.activateAccount(account);
    rememberActiveNest(null);
    window.location.reload();
  }, []);

  const addAccount = useCallback(() => {
    api.beginAddAccount();
    rememberActiveNest(null);
    window.location.reload();
  }, []);

  const forgetAccount = useCallback(async (account: SavedAccount) => {
    await api.signOutSaved(account);
    setSavedAccounts(api.savedAccounts());
  }, []);

  const retryConnection = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      await refresh();
      setServerUnreachable(false);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        api.clearSession();
        setSavedAccounts(api.savedAccounts());
        setServerUnreachable(false);
        setError("Your session has expired. Sign in again.");
      } else {
        setServerUnreachable(true);
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const selectApiServer = useCallback(
    async (url: string) => {
      setBusy(true);
      setError("");
      try {
        api.clearSession();
        api.setBaseUrl(url, true);
        setHome(null);
        setTreeDetails({});
        setNestDetails({});
        setActiveSessions({});
        await refreshServerProperties();
      } catch (err) {
        setError(messageFromError(err, "Server could not be selected"));
        throw err;
      } finally {
        setBusy(false);
        setLoading(false);
      }
    },
    [refreshServerProperties],
  );

  const joinNest = useCallback(
    async (nestId: string) => {
      setBusy(true);
      setError("");
      try {
        const result = await api.joinNest(nestId);
        await refresh();
        return result.status;
      } catch (err) {
        // The threshold turns this into its knock state; it is not a failure to report.
        if (!(err instanceof ApiError && err.reasonCode === "knock_required")) setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const knockUser = useCallback(
    async (userId: string) => {
      const remember = (profileKnock: ProfileKnockState) => setHome((current) => current ? {
        ...current,
        profileKnocks: [...(current.profileKnocks ?? []).filter((state) => state.userId !== userId), profileKnock],
      } : current);
      setBusy(true);
      setError("");
      try {
        const response = await api.createKnock({ toUserId: userId });
        if (response.profileKnock) remember(response.profileKnock);
        await refresh();
      } catch (err) {
        if (err instanceof ApiError && (err.reasonCode === "knock_pending" || err.reasonCode === "knock_cooldown")) {
          const state = (err.details as { profileKnock?: ProfileKnockState } | undefined)?.profileKnock;
          if (state) remember(state);
          throw err;
        }
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const replyToKnock = useCallback(
    async (knockId: string, reply: KnockReply, until?: Date, message?: string) => {
      const knock = home?.pendingKnocks.find((item) => item.id === knockId);
      const name = knock ? knock.fromDisplayName || knock.fromUsername : "They";
      const now = new Date();
      // A message holds only when a time was picked; without one the knocker is free now.
      const holds = reply === "later" ? until : reply === "message" ? (until ?? now) : answerUntil(reply, now);
      if (!holds) throw new Error("Ask me later needs a time.");
      setBusy(true);
      setError("");
      try {
        const sendsUntil = reply === "later" || reply === "not_today" || (reply === "message" && until);
        await api.replyToKnock(knockId, reply, sendsUntil ? holds.toISOString() : undefined, reply === "message" ? message : undefined);
        toast({ title: answerToast(reply, name, holds, now), tone: "success" });
        await refresh();
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [home, refresh],
  );

  const clearKnockAnswer = useCallback((key: string) => {
    setClearedAnswers((current) => new Set(current).add(key));
  }, []);

  const dismissKnock = useCallback(
    async (knockId: string) => {
      setBusy(true);
      setError("");
      try {
        await api.dismissKnock(knockId);
        await refresh();
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const activeNests = home?.activeNests ?? [];
  const temporaryNests = home?.temporaryNests ?? [];
  const trees = home?.trees ?? [];
  const friends = home?.friends ?? [];
  const incomingFriendRequests = home?.incomingFriendRequests ?? [];
  const outgoingFriendRequests = home?.outgoingFriendRequests ?? [];
  const preferences = home?.user.preferences ?? defaultPreferences(home?.user.username);
  const labels = useMemo(() => labelsForPreference(preferences.uiLabels), [preferences.uiLabels]);

  const people = useMemo(() => derivePeople(home, treeDetails), [home, treeDetails]);
  const pending = useMemo(
    () => [...derivePending(home, nestDetails, labels), ...knockAnswers(home?.profileKnocks ?? [], Date.now()).filter((item) => !clearedAnswers.has(item.key))],
    [clearedAnswers, home, labels, nestDetails],
  );

  const getTree = useCallback((id: string) => trees.find((tree) => tree.id === id) ?? treeDetails[id]?.tree, [treeDetails, trees]);
  const getTreeDetails = useCallback((id: string) => treeDetails[id], [treeDetails]);
  const getNestDetails = useCallback((id: string) => nestDetails[id], [nestDetails]);
  const getActiveSession = useCallback((id: string) => activeSessions[id], [activeSessions]);
  const getPerson = useCallback((id: string) => people.find((person) => person.id === id), [people]);
  const getNest = useCallback(
    (id: string) =>
      nestDetails[id]?.nest ??
      activeNests.find((nest) => nest.id === id) ??
      temporaryNests.find((nest) => nest.id === id) ??
      Object.values(treeDetails)
        .flatMap((details) => [...details.activeNests, ...details.inactiveNests])
        .find((nest) => nest.id === id),
    [activeNests, nestDetails, temporaryNests, treeDetails],
  );

  const runMutation = useCallback(
    async <T,>(action: () => Promise<T>) => {
      setBusy(true);
      setError("");
      try {
        const result = await action();
        // Everything fetched before now predates the change. Drop those replies, let a
        // refresh that is already running finish, then fetch what the server holds now.
        const fetches = homeFetchRef.current;
        fetches.applied = ++fetches.started;
        await refreshPromiseRef.current?.catch(() => undefined);
        await refresh();
        return result;
      } catch (err) {
        setError(messageFromError(err));
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const searchUsers = useCallback(async (query: string): Promise<PublicUser[]> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const result = await api.searchUsers(trimmed);
    return result.users;
  }, []);

  const searchTrees = useCallback(async (query: string): Promise<TreeSearchResult[]> => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];
    const result = await api.searchTrees(trimmed);
    return result.trees;
  }, []);

  const createTree = useCallback((name: string) => runMutation(() => api.createTree({ name }).then((result) => result.tree)), [runMutation]);
  const updateTreeSettings = useCallback(
    (treeId: string, settings: { name: string; description: string; joinPolicy: TreeJoinPolicy; visibility: TreeVisibility; savedStickersPublishable?: boolean }) =>
      runMutation(() => api.updateTreeSettings(treeId, settings).then((result) => result.tree)),
    [runMutation],
  );
  const deleteTree = useCallback((treeId: string, confirmation: string) => runMutation(() => api.deleteTree(treeId, confirmation)), [runMutation]);
  const joinTree = useCallback(
    (treeId: string) =>
      runMutation(async () => {
        const result = await api.joinTree(treeId);
        return result.status;
      }),
    [runMutation],
  );
  const createTreeNest = useCallback(
    (treeId: string, name: string, door?: NestDoor) => runMutation(() => api.createTreeNest(treeId, name, door).then((result) => result.nest)),
    [runMutation],
  );
  const renameNest = useCallback((nestId: string, name: string) => runMutation(() => api.renameNest(nestId, name).then(() => undefined)), [runMutation]);
  const letInKnock = useCallback(
    (knockId: string) => runMutation(() => api.acceptKnock(knockId).then(() => undefined)),
    [runMutation],
  );
  const declineRoomKnock = useCallback(
    (knockId: string) => runMutation(() => api.declineKnock(knockId).then(() => undefined)),
    [runMutation],
  );
  const updateNestSettings = useCallback(
    (nestId: string, settings: { name?: string; door?: NestDoor }) => runMutation(() => api.updateNestSettings(nestId, settings).then(() => undefined)),
    [runMutation],
  );
  const deleteNest = useCallback((nestId: string) => runMutation(() => api.archiveNest(nestId)), [runMutation]);
  const addTreeMember = useCallback(
    (treeId: string, username: string, role: TreeRole = "member") =>
      runMutation(() => api.addTreeMember(treeId, username, role).then((result) => result.member)),
    [runMutation],
  );
  const updateTreeMemberRole = useCallback(
    (treeId: string, userId: string, role: TreeRole) =>
      runMutation(() => api.updateTreeMemberRole(treeId, userId, role).then((result) => result.member)),
    [runMutation],
  );
  const updateTreeMemberName = useCallback(
    (treeId: string, userId: string, displayName: string) =>
      runMutation(() => api.updateTreeMemberName(treeId, userId, displayName).then((result) => result.member)),
    [runMutation],
  );
  const removeTreeMember = useCallback((treeId: string, userId: string) => runMutation(() => api.removeTreeMember(treeId, userId)), [runMutation]);
  const leaveTree = useCallback((treeId: string) => runMutation(() => api.leaveTree(treeId)), [runMutation]);
  const transferTreeOwnership = useCallback(
    (treeId: string, userId: string) => runMutation(() => api.transferTreeOwnership(treeId, userId).then((result) => result.member)),
    [runMutation],
  );
  // Not a shell mutation: the form that calls it shows its own error beside the fields.
  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api.changePassword(currentPassword, newPassword);
      setPasswordChangeRequired(false);
      await refresh();
    },
    [refresh],
  );
  const acceptTreeJoinRequest = useCallback((treeId: string, requestId: string) => runMutation(() => api.acceptTreeJoinRequest(treeId, requestId).then(() => undefined)), [runMutation]);
  const rejectTreeJoinRequest = useCallback((treeId: string, requestId: string) => runMutation(() => api.rejectTreeJoinRequest(treeId, requestId).then(() => undefined)), [runMutation]);
  const sendFriendRequest = useCallback((userId: string) => runMutation(() => api.createFriendRequest({ toUserId: userId }).then(() => undefined)), [runMutation]);
  const acceptFriendRequest = useCallback((requestId: string) => runMutation(() => api.acceptFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const declineFriendRequest = useCallback((requestId: string) => runMutation(() => api.declineFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const cancelFriendRequest = useCallback((requestId: string) => runMutation(() => api.cancelFriendRequest(requestId).then(() => undefined)), [runMutation]);
  const removeFriend = useCallback((userId: string) => runMutation(() => api.removeFriend(userId)), [runMutation]);
  const setPresence = useCallback(
    (presence: SelectablePresence) =>
      runMutation(async () => {
        const activeNestId = home?.presence.activeNestId ?? null;
        switch (presence) {
          case "open":
          case "around":
          case "focused":
            await api.updatePresence(activeNestId ? "in_nest" : "available", presence, activeNestId);
            return;
          case "dnd":
            await api.updatePresence("dnd", "unavailable", activeNestId);
            return;
          case "invisible":
            await api.updatePresence("invisible", "unavailable", null);
            return;
        }
      }),
    [home?.presence.activeNestId, runMutation],
  );
  const updatePreferences = useCallback(
    (patch: Parameters<typeof api.updatePreferences>[0]) =>
      runMutation(async () => {
        await api.updatePreferences(patch);
      }),
    [runMutation],
  );

  useEffect(() => {
    const now = Date.now();
    const times = (home?.profileKnocks ?? []).flatMap((state) => [
      Date.parse(state.retryAt),
      state.state === "reminder" && state.replyUntil ? Date.parse(state.replyUntil) + 60 * 60_000 : NaN,
    ]).filter((time) => Number.isFinite(time) && time > now);
    if (times.length === 0) return;
    const delay = Math.min(...times) - now + 1000;
    if (delay > 24 * 60 * 60_000) return;
    const timer = window.setTimeout(() => void refresh().catch(() => undefined), delay);
    return () => window.clearTimeout(timer);
  }, [home, refresh]);

  return {
    user: home?.user ?? null,
    preferences,
    labels,
    serverProperties,
    apiServerUrl,
    apiServerHistory,
    savedAccounts,
    home,
    presence: home?.presence ?? null,
    trees,
    treeDetails,
    nestDetails,
    activeSessions,
    activeNests,
    temporaryNests,
    friends,
    incomingFriendRequests,
    outgoingFriendRequests,
    people,
    pending,
    entryNotices,
    loading,
    busy,
    error,
    notice,
    serverUnreachable,
    login,
    signUp,
    logout,
    accountDeleted,
    switchAccount,
    addAccount,
    forgetAccount,
    sessionExpired,
    selectApiServer,
    refresh,
    retryConnection,
    updatePreferences,
    getTree,
    getNest,
    getPerson,
    getTreeDetails,
    getNestDetails,
    getActiveSession,
    searchUsers,
    searchTrees,
    createTree,
    updateTreeSettings,
    deleteTree,
    joinTree,
    createTreeNest,
    renameNest,
    updateNestSettings,
    letInKnock,
    declineRoomKnock,
    deleteNest,
    addTreeMember,
    updateTreeMemberRole,
    updateTreeMemberName,
    removeTreeMember,
    leaveTree,
    transferTreeOwnership,
    passwordChangeRequired,
    changePassword,
    acceptTreeJoinRequest,
    rejectTreeJoinRequest,
    sendFriendRequest,
    acceptFriendRequest,
    declineFriendRequest,
    cancelFriendRequest,
    removeFriend,
    setPresence,
    joinNest,
    knockUser,
    dismissKnock,
    replyToKnock,
    clearKnockAnswer,
  };
}

export function derivePeople(home: HomeState | null, treeDetails: Record<string, TreeDetails>): ShellPerson[] {
  if (!home) return [];
  const people = new Map<string, ShellPerson>();

  const ensure = (userId: string, name: string, username?: string | null): ShellPerson => {
    const current = people.get(userId);
    if (current) {
      if (!current.username && username) current.username = username;
      return current;
    }
    const next: ShellPerson = { id: userId, name, username: username || undefined, presence: "offline", treeIds: [], activeNestIds: [], relationship: "context" };
    people.set(userId, next);
    return next;
  };
  // Friends, tree members and people in a nest come with where they are. Someone known
  // only through a friend request does not.
  const located = new Set<string>();

  for (const friend of home.friends) {
    const person = ensure(friend.userId, displayNameFor(friend), friend.username);
    person.relationship = "friend";
    located.add(person.id);
    person.presence = presenceFromApi({ state: friend.presenceState, reachability: friend.reachability });
    if (friend.activeNestId && !person.activeNestIds.includes(friend.activeNestId)) person.activeNestIds.push(friend.activeNestId);
  }

  for (const details of Object.values(treeDetails)) {
    for (const member of details.members) {
      if (member.userId === home.user.id) continue;
      // A space nickname stays in its space: people everywhere else go by their usual name.
      const person = ensure(member.userId, member.usualName || displayNameFor(member), member.username);
      located.add(person.id);
      if (person.relationship !== "friend") {
        person.presence = presenceFromApi({ state: member.presenceState, reachability: member.reachability });
      }
      if (!person.treeIds.includes(details.tree.id)) person.treeIds.push(details.tree.id);
    }
  }

  for (const nest of home.activeNests) {
    for (const participant of nest.currentParticipants) {
      if (participant.userId === home.user.id) continue;
      const person = ensure(participant.userId, displayNameFor(participant), participant.username);
      located.add(person.id);
      if (person.relationship !== "friend" && person.presence === "offline") person.presence = "open";
      if (!person.activeNestIds.includes(nest.id)) person.activeNestIds.push(nest.id);
    }
  }

  for (const knock of home.pendingKnocks) {
    if (knock.fromUserId === home.user.id) continue;
    const person = ensure(knock.fromUserId, knock.fromDisplayName || knock.fromUsername, knock.fromUsername);
    located.add(person.id);
    if (person.relationship !== "friend" && person.presence === "offline") person.presence = "open";
  }

  for (const request of [...home.incomingFriendRequests, ...home.outgoingFriendRequests]) {
    const userId = request.fromUserId === home.user.id ? request.toUserId : request.fromUserId;
    const name = request.fromUserId === home.user.id ? request.toDisplayName || request.toUsername : request.fromDisplayName || request.fromUsername;
    const username = request.fromUserId === home.user.id ? request.toUsername : request.fromUsername;
    ensure(userId, name, username);
  }
  for (const person of people.values()) {
    if (!located.has(person.id)) person.presenceUnknown = true;
  }

  return [...people.values()].sort((a, b) => {
    if (a.relationship !== b.relationship) return a.relationship === "friend" ? -1 : 1;
    const presenceDelta = presenceSortRank(a.presence) - presenceSortRank(b.presence);
    if (presenceDelta) return presenceDelta;
    const activeDelta = b.activeNestIds.length - a.activeNestIds.length;
    return activeDelta || a.name.localeCompare(b.name);
  });
}

export function presenceSortRank(presence: ShellPerson["presence"]) {
  return { open: 0, around: 1, focused: 2, dnd: 3, invisible: 4, offline: 5 }[presence];
}

export function derivePending(home: HomeState | null, nestDetails: Record<string, NestDetails>, labels: UILabelCopy): PendingItem[] {
  if (!home) return [];
  const items: PendingItem[] = [];
  for (const knock of home.pendingKnocks) {
    // Older APIs include outgoing knocks in home; only show people reaching us.
    if (knock.fromUserId === home.user.id) continue;
    items.push({
      id: knock.id,
      kind: "knock",
      from: knock.fromDisplayName || knock.fromUsername,
      fromId: knock.fromUserId,
      context: knock.nestName ? `knocked on ${knock.nestName}` : "wants to reach you",
      knock,
    });
  }
  for (const invite of home.pendingInvites) {
    const nest = nestDetails[invite.nestId]?.nest;
    items.push({
      id: invite.id,
      kind: "invite",
      from: displayNameFor(invite),
      nestId: invite.nestId,
      context: nest ? `invited to ${nest.name}` : `invited you to a ${labels.nestSingular}`,
    });
  }
  for (const request of home.pendingRequests) {
    items.push({
      id: request.id,
      kind: "request",
      from: displayNameFor(request),
      fromId: request.userId,
      nestId: request.nestId,
      context: `requested ${request.nestName}`,
      request,
    });
  }
  for (const request of home.incomingFriendRequests) {
    items.push({
      id: request.id,
      kind: "friend",
      from: request.fromDisplayName || request.fromUsername,
      fromId: request.fromUserId,
      context: "sent a friend request",
      request,
    });
  }
  return items;
}
