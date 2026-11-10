import { useCallback, useRef, useState } from "react";
import { api } from "@/lib/api";
import { runNestEntry, type NestEntryPending, type NestEntryResult, type NestEntryRun } from "./nestEntry";

export interface NestEntryController {
  /** The Nest being entered and the seconds left before joining, while the heads-up runs. */
  pending: NestEntryPending | null;
  /** The Nest an entry is running for, from the first click until media is connected. */
  enteringNestId: string | null;
  /** The Nest whose last entry ended in a join request that is still waiting for an answer. */
  requestedNestId: string | null;
  enter: (nestId: string, options?: { muted?: boolean }) => Promise<NestEntryResult>;
  cancel: () => void;
}

export function useNestEntry(
  joinNest: (nestId: string) => Promise<"joined" | "waiting">,
  joinMediaSession: (nestId: string, options?: { muted?: boolean }) => Promise<void>,
  cancelMediaJoin: () => void,
): NestEntryController {
  const [pending, setPending] = useState<NestEntryPending | null>(null);
  const [enteringNestId, setEnteringNestId] = useState<string | null>(null);
  const [requestedNestId, setRequestedNestId] = useState<string | null>(null);
  const runRef = useRef<NestEntryRun | null>(null);

  const cancel = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    run.cancelled = true;
    run.wake?.();
    // Past the heads-up, the entry is waiting on media: stop that too.
    cancelMediaJoin();
  }, [cancelMediaJoin]);

  const enter = useCallback(async (nestId: string, options?: { muted?: boolean }): Promise<NestEntryResult> => {
    // One entry at a time; a second click while one is running is ignored.
    if (runRef.current) return "cancelled";
    const run: NestEntryRun = { cancelled: false, wake: null };
    runRef.current = run;
    setEnteringNestId(nestId);
    try {
      const result = await runNestEntry(
        {
          joinNest,
          announce: (id) => api.announceNestEntry(id).catch(() => null),
          withdraw: (id) => api.cancelNestEntry(id),
          joinMedia: (id) => joinMediaSession(id, options),
          now: () => Date.now(),
          sleep: (ms, onWake) =>
            new Promise<void>((resolve) => {
              const timer = window.setTimeout(resolve, ms);
              onWake(() => {
                window.clearTimeout(timer);
                resolve();
              });
            }),
        },
        nestId,
        run,
        (secondsLeft) => setPending(secondsLeft === null ? null : { nestId, secondsLeft }),
      );
      setRequestedNestId((current) => (result === "waiting" ? nestId : current === nestId ? null : current));
      return result;
    } finally {
      runRef.current = null;
      setPending(null);
      setEnteringNestId(null);
    }
  }, [joinMediaSession, joinNest]);

  return { pending, enteringNestId, requestedNestId, enter, cancel };
}
