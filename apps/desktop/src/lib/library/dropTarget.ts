// Files dropped on the window go to the image tray, unless a library surface (the open
// picker, a library page) has claimed them. The newest claim wins. The claims share one
// listener of their own, so they work where no conversation is open.

import { getCurrentWebview } from "@tauri-apps/api/webview";

type DropHandler = (paths: string[]) => void;

const claims: DropHandler[] = [];
let stopListening: (() => void) | null = null;
let starting = false;

function listen() {
  if (stopListening || starting) return;
  starting = true;
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) claims[claims.length - 1]?.(event.payload.paths);
    })
    .then(
      (unlisten) => {
        starting = false;
        if (claims.length > 0) stopListening = unlisten;
        else unlisten();
      },
      () => {
        starting = false;
      },
    );
}

/** Takes window drops while mounted. Returns the release. */
export function claimDrops(handler: DropHandler): () => void {
  claims.push(handler);
  listen();
  return () => {
    const index = claims.lastIndexOf(handler);
    if (index >= 0) claims.splice(index, 1);
    if (claims.length === 0 && stopListening) {
      stopListening();
      stopListening = null;
    }
  };
}

/** Whether a library surface takes drops now, so the image tray leaves them alone. */
export function dropsClaimed(): boolean {
  return claims.length > 0;
}
