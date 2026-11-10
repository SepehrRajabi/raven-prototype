import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock, Coffee, Flag, Heart, Leaf, Lightbulb, Plane, Search, Smile, Trophy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { loadEmoji, searchEmoji, withTone, type EmojiData, type EmojiEntry } from "@/lib/emoji/data";
import { recentEmoji, recordEmoji, setSkinTone, skinTone } from "@/lib/emoji/prefs";
import { cn } from "@/lib/utils";
import { neighbour } from "@/lib/gridNavigation";

const categories = [
  { name: "Recent", icon: Clock, groups: [] },
  { name: "Smileys and people", icon: Smile, groups: [0, 1] },
  { name: "Animals and nature", icon: Leaf, groups: [3] },
  { name: "Food and drink", icon: Coffee, groups: [4] },
  { name: "Travel and places", icon: Plane, groups: [5] },
  { name: "Activities", icon: Trophy, groups: [6] },
  { name: "Objects", icon: Lightbulb, groups: [7] },
  { name: "Symbols", icon: Heart, groups: [8] },
  { name: "Flags", icon: Flag, groups: [9] },
];
const hands = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/** A reusable picker; its caller owns the floating surface and dismissal. */
export function EmojiPicker({ onPick, autoFocus = false }: { onPick: (emoji: string) => void; autoFocus?: boolean }) {
  const [data, setData] = useState<EmojiData>();
  const [query, setQuery] = useState("");
  const [tone, updateTone] = useState(skinTone);
  const [tonesOpen, setTonesOpen] = useState(false);
  // Read once per open, so a picked emoji stays under the cursor until the picker reopens.
  const [recent] = useState(recentEmoji);
  const [preview, setPreview] = useState<{ entry: EmojiEntry; emoji: string }>();
  const [current, setCurrent] = useState("Smileys and people");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    void loadEmoji().then((value) => { if (alive) setData(value); });
    if (autoFocus) input.current?.focus();
    return () => { alive = false; };
  }, [autoFocus]);
  const searching = query.trim() !== "";
  const recentEntries = recent.flatMap((emoji) => {
    const entry = data?.list.find((item) => item.emoji === emoji || item.skins?.includes(emoji));
    return entry ? [{ entry, emoji: withTone(entry, tone) }] : [];
  }).filter((item, index, items) => items.findIndex((other) => other.emoji === item.emoji) === index);
  const shown = categories.filter((category) => category.name !== "Recent" || recentEntries.length > 0);
  const sections = searching
    ? [{ name: "Search", items: data ? searchEmoji(data, query).map((entry) => ({ entry, emoji: withTone(entry, tone) })) : [] }]
    : shown.map((category) => ({
      name: category.name,
      items: category.name === "Recent" ? recentEntries : (data?.list ?? []).filter((entry) => category.groups.includes(entry.group)).map((entry) => ({ entry, emoji: withTone(entry, tone) })),
    }));
  const pick = (emoji: string) => { recordEmoji(emoji); onPick(emoji); };
  const cells = () => Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-emoji]") ?? []);
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      const all = cells();
      const next = neighbour(all, event.currentTarget, event.key);
      if (next) {
        setActive(all.indexOf(next as HTMLButtonElement));
        next.focus();
        next.scrollIntoView({ block: "nearest" });
      } else if (event.key === "ArrowUp") {
        input.current?.focus();
      }
    } else if (event.key.length === 1 && /\p{L}/u.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); setQuery((value) => value + event.key); setActive(0); input.current?.focus();
    }
  };
  const jumpTo = (name: string) => {
    setQuery(""); setCurrent(name);
    requestAnimationFrame(() => {
      const section = Array.from(grid.current?.querySelectorAll<HTMLElement>("section") ?? []).find((item) => item.dataset.section === name);
      if (section && grid.current) grid.current.scrollTop = section.offsetTop;
    });
  };
  let index = 0;
  return (
    // 8 columns of 40px, 12px in front and room on the other side for the scrollbar.
    <div className="relative flex w-[356px] flex-col">
      <div className="flex items-center gap-1.5 px-3 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input ref={input} placeholder="Search emoji" aria-label="Search emoji" value={query} className="pl-8" onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive(0); cells()[0]?.focus(); }
            if (event.key === "Enter" && searching && sections[0]?.items[0]) { event.preventDefault(); pick(sections[0].items[0].emoji); }
          }} />
        </div>
        <Tooltip label="Skin tone">
          <button type="button" aria-label="Skin tone" aria-expanded={tonesOpen} onClick={() => setTonesOpen(!tonesOpen)} className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-[20px] leading-none transition-colors hover:bg-secondary", tonesOpen && "bg-secondary")}>{hands[tone]}</button>
        </Tooltip>
      </div>
      {tonesOpen ? (
        // Floats over the picker so choosing a tone never shifts the grid.
        <div className="absolute right-3 top-[52px] z-20 flex animate-pop-in gap-0.5 rounded-full bg-popover p-1 shadow-raised" role="group" aria-label="Skin tone">
          {hands.map((hand, value) => (
            <button key={hand} type="button" aria-label={value === 0 ? "No skin tone" : `Skin tone ${value}`} aria-pressed={tone === value} onClick={() => { setSkinTone(value); updateTone(value); setTonesOpen(false); }} className={cn("flex h-8 w-8 items-center justify-center rounded-full text-[18px] leading-none transition-colors hover:bg-secondary", tone === value && "bg-foreground/[0.16] ring-1 ring-inset ring-foreground/25")}>{hand}</button>
          ))}
        </div>
      ) : null}
      <div className="mx-3 mt-2 flex justify-between">
        {shown.map(({ name, icon: Icon }) => {
          const selected = !searching && current === name;
          return <Tooltip key={name} label={name}>
            <button type="button" aria-label={name} aria-pressed={selected} onClick={() => jumpTo(name)} className={cn("flex h-7 w-8 items-center justify-center rounded-chip transition-colors", selected ? "bg-secondary text-foreground" : "text-subtle hover:bg-secondary/60 hover:text-foreground")}>
              <Icon className="h-4 w-4" />
            </button>
          </Tooltip>;
        })}
      </div>
      <div ref={grid} className="relative mt-1 h-[312px] overflow-y-auto pb-1 pl-3 pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]" onScroll={() => {
        if (searching || !grid.current) return;
        const scrolled = grid.current.scrollTop + 8;
        const all = Array.from(grid.current.querySelectorAll<HTMLElement>("section"));
        const passed = all.filter((section) => section.offsetTop <= scrolled);
        const visible = passed[passed.length - 1] ?? all[0];
        if (visible?.dataset.section) setCurrent(visible.dataset.section);
      }}>
        {sections.map((section) => <section key={section.name} data-section={section.name} style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.ceil(section.items.length / 8) * 40 + 28}px` }}>
          {section.name !== "Search" ? <h3 className="sticky top-0 z-10 bg-popover pb-1 pt-2 text-caption font-medium text-muted-foreground">{section.name}</h3> : null}
          <div className="grid grid-cols-[repeat(8,40px)]">{section.items.map(({ entry, emoji }) => {
            const cellIndex = index++;
            return <button
              key={emoji}
              data-emoji
              type="button"
              aria-label={entry.label}
              tabIndex={active === cellIndex ? 0 : -1}
              className="group/cell flex h-10 w-10 items-center justify-center rounded-control text-[26px] leading-none transition-colors hover:bg-secondary focus-visible:bg-secondary"
              onClick={() => pick(emoji)}
              onMouseEnter={() => setPreview({ entry, emoji })}
              onMouseLeave={() => setPreview(undefined)}
              onFocus={() => { setActive(cellIndex); setPreview({ entry, emoji }); }}
              onBlur={() => setPreview(undefined)}
              onKeyDown={gridKey}
            >
              <span className="transition-transform duration-150 group-hover/cell:scale-[1.12] motion-reduce:transition-none">{emoji}</span>
            </button>;
          })}</div>
        </section>)}
        {data && searching && sections[0].items.length === 0 ? <p className="py-10 text-center text-small text-muted-foreground">No emoji found</p> : null}
      </div>
      <div className="flex h-11 items-center gap-2.5 border-t px-3">
        {preview ? <>
          <span className="text-[24px] leading-none">{preview.emoji}</span>
          <span className="min-w-0 flex-1 truncate text-small text-foreground">{preview.entry.label.charAt(0).toUpperCase() + preview.entry.label.slice(1)}</span>
          {preview.entry.shortcodes[0] ? <span className="shrink-0 text-caption text-subtle">:{preview.entry.shortcodes[0]}:</span> : null}
        </> : <span className="text-caption text-subtle">{searching ? "Enter picks the first one" : "Pick an emoji"}</span>}
      </div>
    </div>
  );
}
