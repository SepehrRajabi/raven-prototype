import { useEffect, useMemo } from "react";
import type { CallHost } from "@/lib/callHost";
import { useChat } from "@/shells/ravenv1/useChat";
import { useNestEntry } from "@/shells/ravenv1/useNestEntry";
import { useRavenMediaAdapter } from "@/shells/ravenv1/useRavenMediaAdapter";
import { useRavenShellData } from "@/shells/ravenv1/useRavenShellData";

/** The same data, media, Nest entry and chat owners the desktop shell composes, with the
 * MobileNative call host. */
export function useMobileNativeApp(callHost: CallHost) {
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
    callHost,
  });
  const entry = useNestEntry(data.joinNest, media.joinMediaSession, media.cancelMediaJoin);
  const chat = useChat(data);
  const activeEntryNotices = useMemo(
    () => data.entryNotices.filter((notice) => notice.nestId === media.activeNestId),
    [data.entryNotices, media.activeNestId],
  );

  // Signing out ends the call, so no microphone stays published behind the sign-in screen.
  const signedIn = Boolean(data.user);
  useEffect(() => {
    if (signedIn || !media.activeNestId) return;
    void media.leaveMediaSession().catch(() => undefined);
  }, [signedIn, media.activeNestId, media.leaveMediaSession]);

  return { data, media, entry, chat, activeEntryNotices };
}
