// A browser-like document for the component tests (happy-dom). Import this first in a test
// file, before React, and call `withDom()` at the top of the file. The document is taken
// down after each file, so tests that use the real fetch and Response are not affected.
import { afterAll, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

function open(): void {
  if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register({ url: "http://localhost/" });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

// Registered on import as well, so React's first load sees a document.
open();

export function withDom(): void {
  beforeAll(open);
  afterAll(async () => {
    if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
  });
}
