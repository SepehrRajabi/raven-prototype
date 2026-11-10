import { useMemo } from "react";
import { SettingsPage } from "@/shells/ravenv1/SettingsScaffold";
import { libraryCapabilities } from "@/lib/library/types";
import { LibraryManager } from "./LibraryManager";

const PERSONAL = { scope: "personal" } as const;

/** Settings › GIFs and stickers: one's own library. */
export function LibrarySettingsPage({ properties }: { properties: Record<string, unknown> | undefined }) {
  const capabilities = useMemo(() => libraryCapabilities(properties), [properties]);
  if (!capabilities) {
    return (
      <SettingsPage title="GIFs and stickers" description="The server you are connected to does not have GIFs or stickers.">
        {null}
      </SettingsPage>
    );
  }
  return (
    <SettingsPage title="GIFs and stickers" description="Yours to send anywhere. Make one public and anyone on this server can find it.">
      <LibraryManager owner={PERSONAL} capabilities={capabilities} serverSearch />
    </SettingsPage>
  );
}
