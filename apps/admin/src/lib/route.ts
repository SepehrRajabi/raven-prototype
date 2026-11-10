import { useEffect, useState } from "react";

// Routes live in the URL hash, so the static host needs no rewrite rules and a reload
// keeps the page.
export type Route =
  | { page: "overview" }
  | { page: "users" }
  | { page: "user"; id: string }
  | { page: "spaces" }
  | { page: "space"; id: string }
  | { page: "library" }
  | { page: "settings" }
  | { page: "audit" };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case "users":
      return parts[1] ? { page: "user", id: parts[1] } : { page: "users" };
    case "spaces":
      return parts[1] ? { page: "space", id: parts[1] } : { page: "spaces" };
    case "library":
      return { page: "library" };
    case "settings":
      return { page: "settings" };
    case "audit":
      return { page: "audit" };
    default:
      return { page: "overview" };
  }
}

export function routeHref(route: Route): string {
  switch (route.page) {
    case "user":
      return `#/users/${encodeURIComponent(route.id)}`;
    case "space":
      return `#/spaces/${encodeURIComponent(route.id)}`;
    case "overview":
      return "#/";
    default:
      return `#/${route.page}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHref(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
