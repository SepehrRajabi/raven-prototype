import { useCallback, useMemo, useState } from "react";
import type { RavenView } from "@/shells/ravenv1/state";

const HOME: RavenView = { kind: "home" };

function viewKey(view: RavenView) {
  switch (view.kind) {
    case "home":
    case "settings":
    case "mixer":
    case "messages":
    case "licences":
      return view.kind;
    case "tree-preview":
      return `${view.kind}:${view.result.tree.id}`;
    default:
      return `${view.kind}:${view.id}`;
  }
}

/** Opens `next` on top of the stack. Another section of the same place (a settings
 * category) replaces the top instead, so Back leaves the place in one step. */
export function pushView(stack: RavenView[], next: RavenView): RavenView[] {
  const top = stack[stack.length - 1];
  if (top && viewKey(top) === viewKey(next)) return [...stack.slice(0, -1), next];
  return [...stack, next];
}

/** A Back stack for system Back. Key its owner by user to start over at Home. */
export function useMobileNativeNavigation() {
  const [stack, setStack] = useState<RavenView[]>([HOME]);
  const navigate = useCallback((next: RavenView) => setStack((current) => pushView(current, next)), []);
  const goBack = useCallback(() => setStack((current) => (current.length > 1 ? current.slice(0, -1) : current)), []);
  const canGoBack = stack.length > 1;
  const navigation = useMemo(() => ({ canGoBack, goBack, navigate }), [canGoBack, goBack, navigate]);
  return { view: stack[stack.length - 1] ?? HOME, navigation };
}
