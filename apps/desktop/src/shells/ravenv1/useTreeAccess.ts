import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TreeDetails } from "@/lib/api";
import { failureText } from "@/lib/chat/errors";
import { existingNestRefs, layoutSections, type LayoutSection } from "@/lib/chat/layout";
import { textNestsOfTree } from "@/lib/chat/reducer";
import type { ChatStore } from "@/lib/chat/store";
import { subscribeNestUpdates } from "@/lib/eventStream";
import { liveRules, nextEnd, roomKey, type AccessNames, type RoomNouns, type RoomRef, type TreeAccess } from "@/lib/roomAccess";
import type { RavenShellData } from "./state";
import { useChatState } from "./useChat";
import { useNow } from "./useNow";

/** Longer than this and a timer would overflow; the minute tick catches a later end. */
const MAX_TIMER_MS = 24 * 60 * 60_000;

/**
 * A tree's rules and labels, for its owner. Fetched again when the server says something
 * in the tree changed, when the window comes back to the front, and when a rule ends.
 */
export function useTreeAccess(treeId: string) {
  const [access, setAccess] = useState<TreeAccess | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  // Goes up with every answer, so what is derived on the server is asked for again.
  const [version, setVersion] = useState(0);
  const now = useNow();
  const ticket = useRef(0);

  const take = useCallback((next: TreeAccess) => {
    setAccess(next);
    setLoadError("");
    setVersion((current) => current + 1);
  }, []);

  const reload = useCallback(async () => {
    const mine = ++ticket.current;
    try {
      const next = await api.treeAccess(treeId);
      if (mine === ticket.current) take(next);
    } catch (failure) {
      if (mine === ticket.current) setLoadError(failureText(failure, "The server could not be reached."));
    }
  }, [take, treeId]);

  const run = useCallback(async (change: () => Promise<void>): Promise<string> => {
    setBusy(true);
    try {
      await change();
      return "";
    } catch (failure) {
      return failureText(failure, "The server could not be reached. Nothing changed.");
    } finally {
      setBusy(false);
    }
  }, []);

  /** Makes a change the server answers with the new state. "" when it was saved, otherwise why not. */
  const change = useCallback(
    (request: () => Promise<TreeAccess>) =>
      run(async () => {
        const mine = ++ticket.current;
        const next = await request();
        if (mine === ticket.current) take(next);
        // Something was fetched while this was on its way and may predate it.
        else await reload();
      }),
    [reload, run, take],
  );

  /** The same for a change the server does not answer with the new state. */
  const changeThenReload = useCallback(
    (request: () => Promise<unknown>) =>
      run(async () => {
        await request();
        await reload();
      }),
    [reload, run],
  );

  useEffect(() => {
    setAccess(null);
    void reload();
    let timer: number | null = null;
    const soon = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void reload();
      }, 200);
    };
    const unsubscribe = subscribeNestUpdates((update) => {
      if (update.treeId === treeId || update.type === "stream.reconnected") soon();
    });
    window.addEventListener("focus", soon);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", soon);
      ticket.current += 1;
    };
  }, [reload, treeId]);

  // A rule that ends while this is open leaves the list then.
  const end = access ? nextEnd(access.rules, Date.now()) : null;
  useEffect(() => {
    if (end === null) return;
    const delay = end - Date.now() + 500;
    if (delay > MAX_TIMER_MS) return;
    const timer = window.setTimeout(() => void reload(), Math.max(delay, 0));
    return () => window.clearTimeout(timer);
  }, [end, reload, version]);

  const live = useMemo(() => (access ? { ...access, rules: liveRules(access.rules, now) } : null), [access, now]);
  return { access: live, loadError, busy, version, now, reload, change, changeThenReload };
}

export type TreeAccessState = ReturnType<typeof useTreeAccess>;

/** Asks before something hides rooms from every member. `guard` resolves to whether to go on. */
export function useHideGuard() {
  const [asking, setAsking] = useState<{ hidden: RoomRef[]; answer: (go: boolean) => void } | null>(null);
  const guard = useCallback((hidden: RoomRef[]) => (hidden.length === 0 ? Promise.resolve(true) : new Promise<boolean>((resolve) => setAsking({ hidden, answer: resolve }))), []);
  const answer = useCallback(
    (go: boolean) => {
      asking?.answer(go);
      setAsking(null);
    },
    [asking],
  );
  return { hidden: asking?.hidden ?? null, guard, answer };
}

export interface TreeRooms {
  /** The rooms by category, as the lobby lists them. */
  sections: LayoutSection[];
  /** The same in one list. */
  rooms: RoomRef[];
  names: AccessNames;
}

/** A tree's rooms in the lobby's order, and what to call them and their labels. */
export function useTreeRooms(details: TreeDetails, data: RavenShellData, chat: ChatStore | null | undefined, access: TreeAccess | null): TreeRooms {
  const treeId = details.tree.id;
  const state = useChatState(chat ?? null);
  const layout = state?.layouts[treeId];
  useEffect(() => {
    void chat?.loadLayout(treeId).catch(() => undefined);
  }, [chat, treeId]);

  const voice = useMemo(() => [...details.activeNests, ...details.inactiveNests].filter((nest) => nest.type === "persistent"), [details.activeNests, details.inactiveNests]);
  const text = useMemo(() => (state ? textNestsOfTree(state, treeId) : []), [state, treeId]);
  const labels = access?.labels;
  const { nestSingular, nestPlural } = data.labels;

  return useMemo(() => {
    const sections = layoutSections(layout, existingNestRefs(text, voice));
    const rooms = sections.flatMap((section) => section.items);
    const roomNames = new Map([
      ...voice.map((nest) => [roomKey({ kind: "voice", id: nest.id }), nest.name] as const),
      ...text.map((nest) => [roomKey({ kind: "text", id: nest.summary.id }), nest.summary.name ?? ""] as const),
    ]);
    const labelNames = new Map((labels ?? []).map((label) => [label.id, label.name]));
    const nouns: RoomNouns = { one: nestSingular.toLowerCase(), many: nestPlural.toLowerCase() };
    return {
      sections,
      rooms,
      names: { nouns, room: (room) => roomNames.get(roomKey(room)) || undefined, label: (id) => labelNames.get(id) },
    };
  }, [labels, layout, nestPlural, nestSingular, text, voice]);
}
