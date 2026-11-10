import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Avatar } from "@/components/ui/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ArrowDownToLine, Bell, Check, ChevronLeft, ChevronRight, Command, Copy, Minus, Search, Square, UserMinus, UserPlus, X } from "lucide-react";
import type { RavenShellData, RavenView } from "./state";
import { displayNameFor } from "./state";
import { PendingList } from "./Inbox";
import { friendStanding, strangerNamed } from "./people";
import { usePendingActions } from "./usePendingActions";
import { FOCUS_SEARCH_EVENT } from "./searchFocus";
import type { PublicUser, TreeSearchResult } from "@/lib/api";
import type { UpdaterSnapshot } from "@/lib/updater";

export function TopBar({
  data,
  onNavigate,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  update,
}: {
  data: RavenShellData;
  onNavigate: (view: RavenView) => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  update: UpdaterSnapshot | null;
}) {
  return (
    <header
      className="raven-window-drag grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_minmax(200px,440px)_minmax(0,1fr)] items-center gap-3 bg-background pl-2 text-foreground"
      onMouseDown={handleCaptionMouseDown}
    >
      <div className="flex items-center gap-0.5">
        <CaptionIconButton label="Back" disabled={!canGoBack} onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
        </CaptionIconButton>
        <CaptionIconButton label="Forward" disabled={!canGoForward} onClick={onForward}>
          <ChevronRight className="h-4 w-4" />
        </CaptionIconButton>
      </div>

      <GlobalSearch data={data} onNavigate={onNavigate} />

      <div className="flex items-center justify-end">
        <UpdateNotice update={update} onOpen={() => onNavigate({ kind: "settings", section: "updates" })} />
        <InboxButton data={data} onNavigate={onNavigate} />
        <WindowCaptionControls />
      </div>
    </header>
  );
}

export function BareTopBar({ title = "Raven" }: { title?: string }) {
  return (
    <header
      className="raven-window-drag flex h-10 shrink-0 items-center bg-background pl-3 text-foreground"
      onMouseDown={handleCaptionMouseDown}
    >
      <div className="min-w-0 truncate text-small font-medium text-muted-foreground">{title}</div>
      <div className="min-w-0 flex-1" />
      <WindowCaptionControls />
    </header>
  );
}

function InboxButton({ data, onNavigate }: { data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const [open, setOpen] = useState(false);
  const count = data.pending.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label={count ? `${count} waiting for you` : "Inbox"} side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={count ? `Inbox, ${count} waiting for you` : "Inbox"}
            className={cn(
              "raven-no-drag relative mr-1 flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
              open && "bg-secondary text-foreground",
            )}
          >
            <Bell className="h-4 w-4" />
            {count > 0 ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-foreground" /> : null}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="raven-no-drag w-[380px] p-2">
        <div className="px-2 pb-1.5 pt-1 text-small font-medium">Reaching you</div>
        {count > 0 ? (
          <PendingList data={data} onNavigate={onNavigate} onAfterAction={() => setOpen(false)} surface="popover" />
        ) : (
          <p className="px-2 pb-2 text-small text-muted-foreground">Nobody is waiting on you.</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Shown only while a newer version is waiting. It opens Settings, where the user acts. */
function UpdateNotice({ update, onOpen }: { update: UpdaterSnapshot | null; onOpen: () => void }) {
  if (!update?.available || !["available", "downloading", "ready"].includes(update.phase)) return null;
  const label = update.phase === "ready" ? "Restart to update" : "Update available";
  return (
    <Tooltip label={`Raven ${update.available.version}`} side="bottom">
      <button
        type="button"
        onClick={onOpen}
        className="raven-no-drag mr-1 flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2 text-caption text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <ArrowDownToLine className="h-3.5 w-3.5" />
        {label}
      </button>
    </Tooltip>
  );
}

function CaptionIconButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="raven-no-drag flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function WindowCaptionControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = currentTauriWindow();
    if (!appWindow) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void (maximizeIsFullScreen ? appWindow.isFullscreen() : appWindow.isMaximized())
        .then((nextMaximized) => {
          if (active) setMaximized(nextMaximized);
        })
        .catch(() => undefined);
    };

    refresh();
    appWindow
      .onResized(refresh)
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const minimize = () => {
    void currentTauriWindow()?.minimize();
  };
  const toggleMaximize = () => {
    const appWindow = currentTauriWindow();
    if (!appWindow) return;
    void toggleWindowMaximize(appWindow).then(setMaximized).catch(() => undefined);
  };
  const close = () => {
    void currentTauriWindow()?.close();
  };

  return (
    <div className="raven-no-drag flex h-10 shrink-0 items-stretch" aria-label="Window controls">
      <CaptionButton label="Minimize" glyph={0xe921} icon={Minus} onClick={minimize} />
      <CaptionButton
        label={maximized ? "Restore" : "Maximize"}
        glyph={maximized ? 0xe923 : 0xe922}
        icon={maximized ? Copy : Square}
        onClick={toggleMaximize}
      />
      <CaptionButton label="Close" glyph={0xe8bb} icon={X} danger onClick={close} />
    </div>
  );
}

// Windows draws the caption glyphs from its own icon font, like native windows do. Other
// platforms have no such font, so they get the same shapes as drawn icons.
const hasSegoeCaptionFont = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

function CaptionButton({
  label,
  glyph,
  icon: Icon,
  danger,
  onClick,
}: {
  label: string;
  glyph: number;
  icon: typeof X;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-10 w-[46px] cursor-default items-center justify-center text-[10px] text-muted-foreground transition-colors",
        // The close colour is the Windows caption convention, not a palette token.
        danger ? "hover:bg-[#c42b1c] hover:text-white" : "hover:bg-secondary hover:text-foreground",
      )}
    >
      {hasSegoeCaptionFont ? (
        <span
          aria-hidden
          className="leading-none"
          style={{ fontFamily: "\"Segoe Fluent Icons\", \"Segoe MDL2 Assets\", \"Segoe UI Symbol\", sans-serif" }}
        >
          {String.fromCharCode(glyph)}
        </span>
      ) : (
        <Icon aria-hidden className="size-3.5" strokeWidth={1.25} />
      )}
    </button>
  );
}

function handleCaptionMouseDown(event: MouseEvent<HTMLElement>) {
  if (event.button !== 0) return;
  const target = event.target;
  if (!(target instanceof HTMLElement) || isInteractiveCaptionTarget(target)) return;
  const appWindow = currentTauriWindow();
  if (!appWindow) return;
  if (event.detail >= 2) {
    event.preventDefault();
    void toggleWindowMaximize(appWindow).catch(() => undefined);
    return;
  }
  void appWindow.startDragging();
}

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/i.test(navigator.userAgent);

// On macOS a maximized ("zoomed") window still sits under the menu bar; only full screen
// takes the whole display, so there the maximize button means full screen.
const maximizeIsFullScreen = isMac;

/** Maximizes or restores the window (full screen on macOS); resolves to the new state. */
async function toggleWindowMaximize(appWindow: ReturnType<typeof getCurrentWindow>): Promise<boolean> {
  if (maximizeIsFullScreen) {
    const next = !(await appWindow.isFullscreen());
    await appWindow.setFullscreen(next);
    return next;
  }
  await appWindow.toggleMaximize();
  return appWindow.isMaximized();
}

/** The search shortcut's hint: the ⌘ symbol on macOS (spelled out for screen readers), Ctrl elsewhere. */
function SearchShortcut() {
  return (
    <kbd className="rv-mono flex shrink-0 items-center gap-0.5 text-caption text-subtle">
      {isMac ? (
        <>
          <Command aria-hidden className="h-3 w-3" />
          <span className="sr-only">Command</span>
        </>
      ) : (
        "Ctrl"
      )}{" "}
      K
    </kbd>
  );
}

function currentTauriWindow(): ReturnType<typeof getCurrentWindow> | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

function isInteractiveCaptionTarget(target: HTMLElement) {
  return Boolean(
    target.closest(
      [
        "button",
        "input",
        "textarea",
        "select",
        "a",
        "[role='button']",
        "[role='menu']",
        "[role='menuitem']",
        "[role='listbox']",
        "[role='option']",
        "[data-radix-popper-content-wrapper]",
        ".raven-no-drag",
      ].join(","),
    ),
  );
}

type SearchEntry =
  | { kind: "user"; key: string; user: PublicUser }
  | { kind: "tree"; key: string; result: TreeSearchResult };

function GlobalSearch({ data, onNavigate }: { data: RavenShellData; onNavigate: (view: RavenView) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [trees, setTrees] = useState<TreeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const treePlural = data.labels.treePlural.toLowerCase();
  const label = `Search people and ${treePlural}`;
  const ready = query.trim().length >= 2;
  const { searchUsers, searchTrees } = data;

  useEffect(() => {
    if (!open || !ready) {
      setUsers([]);
      setTrees([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      Promise.all([searchUsers(query), searchTrees(query)])
        .then(([nextUsers, nextTrees]) => {
          if (!cancelled) {
            setUsers(nextUsers);
            setTrees(nextTrees);
            setActiveIndex(0);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setUsers([]);
            setTrees([]);
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, ready, searchTrees, searchUsers]);

  useEffect(() => {
    const focus = () => {
      setOpen(true);
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Command K on macOS, where Control K is the text fields' "delete to end of line".
      const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      const commandK = event.key.toLowerCase() === "k" && modifier && !event.altKey;
      const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!commandK && !slash) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (slash && isTypingTarget(event.target)) return;
      event.preventDefault();
      focus();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const entries = useMemo<SearchEntry[]>(
    () => [
      ...users.map((user): SearchEntry => ({ kind: "user", key: `user:${user.id}`, user })),
      ...trees.map((result): SearchEntry => ({ kind: "tree", key: `tree:${result.tree.id}`, result })),
    ],
    [trees, users],
  );

  const close = () => {
    setOpen(false);
    inputRef.current?.blur();
  };

  const openEntry = (entry: SearchEntry) => {
    if (entry.kind === "user") {
      const user = entry.user;
      onNavigate({
        kind: "user",
        id: user.id,
        // Search says who someone is, not where they are.
        person: strangerNamed(user.id, displayNameFor(user), user.username),
      });
    } else {
      const result = entry.result;
      onNavigate(
        result.accessState === "joined" && data.getTreeDetails(result.tree.id)
          ? { kind: "tree", id: result.tree.id }
          : { kind: "tree-preview", result },
      );
    }
    setQuery("");
    close();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else close();
      return;
    }
    if (!entries.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + entries.length) % entries.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = entries[Math.min(activeIndex, entries.length - 1)];
      if (entry) openEntry(entry);
    }
  };

  return (
    <div ref={rootRef} className="raven-no-drag relative min-w-0">
      <div
        className={cn(
          "flex h-7 items-center gap-2 rounded-control bg-card px-2.5 text-muted-foreground transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-ring/50",
          open ? "bg-secondary" : "hover:bg-secondary",
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls="raven-search-results"
          aria-label={label}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOpen(true);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={label}
          className="h-full min-w-0 flex-1 bg-transparent text-small text-foreground outline-none placeholder:text-subtle focus-visible:outline-none"
        />
        {query ? (
          <button type="button" aria-label="Clear search" className="text-subtle hover:text-foreground" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <SearchShortcut />
        )}
      </div>

      {open && query.trim().length > 0 ? (
        <div
          id="raven-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-9 z-50 max-h-[360px] animate-pop-in overflow-y-auto rounded-card bg-popover p-1.5 shadow-raised"
        >
          {!ready ? (
            <SearchNote>Keep typing to search.</SearchNote>
          ) : searching && !entries.length ? (
            <SearchNote>Searching…</SearchNote>
          ) : entries.length ? (
            <>
              {users.length ? <SearchGroupLabel>People</SearchGroupLabel> : null}
              {entries.map((entry, index) => {
                const active = index === activeIndex;
                const firstTree = entry.kind === "tree" && index === users.length;
                return (
                  <div key={entry.key}>
                    {firstTree ? <SearchGroupLabel>{`Public ${treePlural}`}</SearchGroupLabel> : null}
                    <div
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={cn("flex items-center gap-2 rounded-control px-2 py-1.5", active && "bg-accent/70")}
                    >
                      <button type="button" tabIndex={-1} onClick={() => openEntry(entry)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                        {entry.kind === "user" ? (
                          <>
                            <Avatar name={displayNameFor(entry.user)} src={api.userAvatarUrl(entry.user.id)} className="h-7 w-7" />
                            <span className="min-w-0">
                              <span className="block truncate text-small font-medium">{displayNameFor(entry.user)}</span>
                              <span className="block truncate text-caption text-muted-foreground">@{entry.user.username} · {relationshipLabel(friendStanding(entry.user.id, data).relationship)}</span>
                            </span>
                          </>
                        ) : (
                          <>
                            <Avatar name={entry.result.tree.name} src={api.treeAvatarUrl(entry.result.tree.id, entry.result.tree.updatedAt)} className="h-7 w-7 rounded-control" />
                            <span className="min-w-0">
                              <span className="block truncate text-small font-medium">{entry.result.tree.name}</span>
                              <span className="block truncate text-caption text-muted-foreground">{treeResultSummary(entry.result)}</span>
                            </span>
                          </>
                        )}
                      </button>
                      {entry.kind === "user" ? <SearchAction user={entry.user} data={data} /> : null}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <SearchNote>No people or {treePlural} match “{query.trim()}”.</SearchNote>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SearchNote({ children }: { children: ReactNode }) {
  return <div className="px-2 py-3 text-small text-muted-foreground">{children}</div>;
}

function SearchGroupLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-2 text-caption text-subtle first:pt-1">{children}</div>;
}

function treeResultSummary(result: TreeSearchResult) {
  const state = result.accessState === "joined" ? "Joined" : result.accessState === "pending" ? "Request sent" : result.tree.joinPolicy === "free" ? "Open to join" : "Ask to join";
  return result.tree.description ? `${state} · ${result.tree.description}` : state;
}

function SearchAction({ user, data }: { user: PublicUser; data: RavenShellData }) {
  const actions = usePendingActions();
  // The row was fetched when the search ran; what can be done now comes from live data.
  const { relationship, requestId } = friendStanding(user.id, data);
  const busy = actions.isPending(user.id);
  if (relationship === "self") return <span className="px-1 text-caption text-subtle">You</span>;
  if (relationship === "friends") return <span className="px-1 text-caption text-subtle">Friend</span>;
  if (relationship === "incoming_pending" && requestId) {
    return (
      <div className="flex gap-0.5">
        <IconAction label="Accept friend request" disabled={busy} onClick={() => actions.run(user.id, () => data.acceptFriendRequest(requestId))}>
          <Check className="h-4 w-4" />
        </IconAction>
        <IconAction label="Decline friend request" disabled={busy} onClick={() => actions.run(user.id, () => data.declineFriendRequest(requestId))}>
          <X className="h-4 w-4" />
        </IconAction>
      </div>
    );
  }
  if (relationship === "outgoing_pending" && requestId) {
    return (
      <IconAction label="Cancel friend request" disabled={busy} onClick={() => actions.run(user.id, () => data.cancelFriendRequest(requestId))}>
        <UserMinus className="h-4 w-4" />
      </IconAction>
    );
  }
  return (
    <IconAction label="Send friend request" disabled={busy} onClick={() => actions.run(user.id, () => data.sendFriendRequest(user.id))}>
      <UserPlus className="h-4 w-4" />
    </IconAction>
  );
}

function IconAction({ children, label, disabled, onClick }: { children: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      tabIndex={-1}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
    >
      {children}
    </button>
  );
}

function relationshipLabel(relationship: PublicUser["relationship"]) {
  if (relationship === "self") return "you";
  if (relationship === "friends") return "friend";
  if (relationship === "incoming_pending") return "sent you a request";
  if (relationship === "outgoing_pending") return "request sent";
  return "not connected";
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}
