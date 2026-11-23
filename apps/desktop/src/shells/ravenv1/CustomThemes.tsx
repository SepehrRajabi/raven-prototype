import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Check, Download, MoreHorizontal, Palette, Pencil, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { savedFileName } from "@/lib/accountExit";
import {
  addThemeFromFile,
  chooseTheme,
  contrastRatio,
  currentTokenColor,
  deleteTheme,
  exportThemeCss,
  over,
  parseColor,
  previewThemeCss,
  renameTheme,
  saveTheme,
  themeCss,
  themeFileName,
  themeToken,
  THEME_TOKEN_GROUPS,
  THEME_TOKENS,
  toHex,
  toTriple,
  useCustomThemes,
  validTokenValue,
  ThemeError,
  type CustomTheme,
  type Rgb,
  type ThemeToken,
} from "@/lib/customThemes";
import { cn } from "@/lib/utils";
import { SettingsHint, SettingsSection } from "./SettingsScaffold";

function failure(error: unknown, fallback: string): string {
  if (error instanceof ThemeError) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

async function exportTheme(theme: CustomTheme) {
  try {
    const bytes = new TextEncoder().encode(exportThemeCss(theme));
    const saved = await invoke<string | null>("save_theme_file", bytes, { headers: { "X-Raven-Theme-Name": themeFileName(theme.name) } });
    if (saved) toast({ title: `Saved “${theme.name}” as ${savedFileName(saved)}.`, tone: "success" });
  } catch (error) {
    toast({ title: failure(error, "Couldn’t save the theme file."), tone: "error" });
  }
}

/**
 * Settings › Appearance › Custom themes: the themes kept on this device, and the way in to
 * loading one from a file or making one. Choosing one here replaces the theme above.
 */
export function CustomThemesSection({ onEdit }: { onEdit: (id: string | null) => void }) {
  const { themes, activeId } = useCustomThemes();
  const [renaming, setRenaming] = useState<CustomTheme | null>(null);
  const [deleting, setDeleting] = useState<CustomTheme | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const file = await invoke<{ name: string; text: string } | null>("open_theme_file");
      if (!file) return;
      const { theme, removed } = addThemeFromFile(file.name, file.text);
      toast({
        title: `Added “${theme.name}”. Choose it to use it.`,
        description: removed > 0 ? `Took out ${removed === 1 ? "one link" : `${removed} links`} to other addresses: a theme can’t load anything from the internet.` : undefined,
        tone: "success",
      });
    } catch (error) {
      toast({ title: failure(error, "Couldn’t load that theme."), tone: "error" });
    } finally {
      setLoading(false);
    }
  };

  const choose = (id: string | null) => {
    try {
      chooseTheme(id);
    } catch (error) {
      toast({ title: failure(error, "Couldn’t change the theme."), tone: "error" });
    }
  };

  return (
    <SettingsSection
      title="Custom themes"
      description="Your own colours, from a CSS file or made here. While one is in use, it replaces the theme above. They are kept on this device and never sent to the server."
    >
      <div role="radiogroup" aria-label="Custom themes" className="divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50">
        <ThemeChoiceRow name="Built-in theme" detail="The colours chosen above." selected={activeId === null} onSelect={() => choose(null)} />
        {themes.map((theme) => (
          <ThemeChoiceRow
            key={theme.id}
            name={theme.name}
            detail={theme.origin === "file" ? "Loaded from a file" : "Made here"}
            selected={activeId === theme.id}
            onSelect={() => choose(theme.id)}
            menu={(
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`More for ${theme.name}`}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => onEdit(theme.id)}>
                    <Palette className="text-muted-foreground" />
                    Edit colours
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setRenaming(theme)}>
                    <Pencil className="text-muted-foreground" />
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void exportTheme(theme)}>
                    <Download className="text-muted-foreground" />
                    Export as CSS…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setDeleting(theme)}>
                    <Trash2 className="text-muted-foreground" />
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load()}>
          <Upload className="h-4 w-4" />
          {loading ? "Loading…" : "Load CSS file…"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => onEdit(null)}>
          <Plus className="h-4 w-4" />
          New theme…
        </Button>
      </div>
      <SettingsHint>
        A theme can change how anything in Raven looks, and could even hide the sign that your camera or microphone is on. Only load files from people you trust. Raven takes out
        anything in a file that would load from the internet.
      </SettingsHint>

      <RenameDialog theme={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        description={deleting && activeId === deleting.id ? "It is in use: Raven goes back to the built-in theme. Export it first if you want to keep a copy." : "Export it first if you want to keep a copy."}
        confirmLabel="Delete"
        destructive
        focusCancel
        onConfirm={() => {
          if (deleting) {
            try {
              deleteTheme(deleting.id);
            } catch (error) {
              toast({ title: failure(error, "Couldn’t delete the theme."), tone: "error" });
            }
          }
          setDeleting(null);
        }}
      />
    </SettingsSection>
  );
}

function ThemeChoiceRow({ name, detail, selected, onSelect, menu }: { name: string; detail: string; selected: boolean; onSelect: () => void; menu?: ReactNode }) {
  return (
    <div data-settings-item={name} className="flex items-center gap-1 pr-2">
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        onClick={onSelect}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary focus-visible:-outline-offset-2"
      >
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
            selected ? "border-foreground bg-foreground text-background" : "border-foreground/35",
          )}
        >
          {selected ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-body"><bdi>{name}</bdi></span>
          <span className="block text-caption text-muted-foreground">{selected ? `${detail} · In use` : detail}</span>
        </span>
      </button>
      {menu}
    </div>
  );
}

function RenameDialog({ theme, onClose }: { theme: CustomTheme | null; onClose: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (theme) setName(theme.name);
  }, [theme]);
  const save = () => {
    if (!theme) return;
    try {
      renameTheme(theme.id, name);
      onClose();
    } catch (error) {
      toast({ title: failure(error, "Couldn’t rename the theme."), tone: "error" });
    }
  };
  return (
    <Dialog open={theme !== null} onOpenChange={(open) => !open && onClose()} title="Rename theme" widthClassName="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Input value={name} onChange={(event) => setName(event.currentTarget.value)} aria-label="Theme name" maxLength={60} dir="auto" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name.trim()}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---- the editor -------------------------------------------------------------------

/** What every token shows right now, captured before the editor's own preview applies. */
function captureCurrent(): Record<string, Rgb | null> {
  const out: Record<string, Rgb | null> = {};
  for (const token of THEME_TOKENS) out[token.name] = currentTokenColor(token.name);
  return out;
}

/**
 * Every colour a theme can set, one row each, grouped as people see them. Changes show in
 * the whole window at once; Cancel puts back what was there.
 */
export function ThemeEditor({ themeId, onClose }: { themeId: string | null; onClose: () => void }) {
  const { themes } = useCustomThemes();
  const editing = themeId ? themes.find((theme) => theme.id === themeId) : undefined;
  const [base] = useState(captureCurrent);
  const [name, setName] = useState(editing?.name ?? "");
  const [tokens, setTokens] = useState<Record<string, string>>(() => {
    if (editing) return { ...editing.tokens };
    // A new theme starts from what is on screen, so the first change is the only change.
    const start: Record<string, string> = {};
    for (const token of THEME_TOKENS) {
      const color = base[token.name];
      if (token.kind === "triple" && !token.followsSetting && color) start[token.name] = toHex(color);
    }
    return start;
  });
  const extraCss = editing?.extraCss ?? "";
  const nameField = useRef<HTMLInputElement>(null);

  // What is on screen once the preview applies: swatches and contrast read from it, so they
  // show what people will see, including colours the theme leaves to Raven's defaults.
  const [shown, setShown] = useState(base);
  useEffect(() => {
    previewThemeCss(themeCss({ tokens, extraCss }));
    setShown(captureCurrent());
  }, [tokens, extraCss]);
  useEffect(() => () => previewThemeCss(null), []);
  useEffect(() => nameField.current?.focus(), []);

  const set = (token: string, value: string | undefined) =>
    setTokens((current) => {
      const next = { ...current };
      if (value === undefined) delete next[token];
      else next[token] = value;
      return next;
    });

  const invalid = THEME_TOKENS.filter((token) => tokens[token.name] !== undefined && !validTokenValue(token, tokens[token.name]));
  const draft = (): Omit<CustomTheme, "updatedAt" | "origin"> => ({ id: editing?.id ?? "", name: name || "Untitled theme", tokens, extraCss });

  const save = () => {
    if (invalid.length) return;
    try {
      const saved = saveTheme({ ...draft(), id: editing?.id });
      chooseTheme(saved.id);
      onClose();
    } catch (error) {
      toast({ title: failure(error, "Couldn’t save the theme."), tone: "error" });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
        <div className="mx-auto w-full max-w-[680px] px-8 py-8">
          <Button variant="ghost" size="xs" className="-ml-2.5" onClick={onClose}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Appearance
          </Button>
          <h1 className="mt-2 text-title font-semibold">{editing ? "Edit theme" : "New theme"}</h1>
          <p className="mt-1 text-small text-muted-foreground">
            Changes show in the whole window as you make them. A colour that follows another changes with it until you set it.
          </p>
          <label className="mt-6 block space-y-1.5 text-small text-muted-foreground">
            Name
            <Input ref={nameField} value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Untitled theme" maxLength={60} dir="auto" />
          </label>

          <div className="mt-8 space-y-8">
            {THEME_TOKEN_GROUPS.map((group) => (
              <section key={group.id} aria-labelledby={`theme-group-${group.id}`}>
                <h2 id={`theme-group-${group.id}`} className="text-title-sm font-semibold">{group.label}</h2>
                {group.description ? <p className="mt-1 max-w-xl text-small text-muted-foreground">{group.description}</p> : null}
                <div className="mt-3 divide-y divide-border/70 overflow-hidden rounded-card bg-secondary/50">
                  {THEME_TOKENS.filter((token) => token.group === group.id).map((token) => (
                    <TokenRow
                      key={token.name}
                      token={token}
                      value={tokens[token.name]}
                      color={shown[token.name] ?? null}
                      against={token.on ? (shown[token.on] ?? null) : null}
                      backdrop={shown.card ?? null}
                      startValue={editing ? editing.tokens[token.name] : !token.followsSetting && base[token.name] ? toHex(base[token.name]!) : undefined}
                      onChange={(value) => set(token.name, value)}
                    />
                  ))}
                </div>
              </section>
            ))}
            {extraCss ? (
              <SettingsHint>This theme also holds other CSS from its file. It is kept as it is; edit the file to change it.</SettingsHint>
            ) : null}
          </div>
        </div>
      </div>
      <div className="border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-[680px] items-center gap-2 px-8 py-3">
          {invalid.length ? <p className="min-w-0 truncate text-small text-destructive" role="alert">Check {invalid[0].label.toLowerCase()}: Raven can’t read that colour.</p> : null}
          <span className="ml-auto flex shrink-0 gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="secondary" disabled={invalid.length > 0} onClick={() => void exportTheme({ ...draft(), id: editing?.id ?? "", origin: "editor", updatedAt: "" })}>
              <Download className="h-4 w-4" />
              Export…
            </Button>
            <Button disabled={invalid.length > 0} onClick={save}>Save and use</Button>
          </span>
        </div>
      </div>
    </div>
  );
}

function TokenRow({
  token,
  value,
  color,
  against,
  backdrop,
  startValue,
  onChange,
}: {
  token: ThemeToken;
  value: string | undefined;
  color: Rgb | null;
  against: Rgb | null;
  /** What see-through colours sit on: the main panel, where most controls are. */
  backdrop: Rgb | null;
  startValue: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const follows = token.kind === "color" && token.fallback ? themeToken(token.fallback.token) : undefined;
  // What an empty value follows: another token, or a setting. Such a token can be emptied.
  const followsLabel = follows ? follows.label.toLowerCase() : token.followsSetting?.toLowerCase();
  const canFollow = followsLabel !== undefined;
  // A see-through colour is measured as it looks: laid over what is under it.
  const flat = (rgb: Rgb | null) => (rgb && backdrop ? over(rgb, backdrop) : rgb);
  const under = flat(against);
  const ratio = color && under ? contrastRatio(over(color, under), under) : null;
  const enough = token.shape ? 3 : 4.5;
  // The swatch keeps the exact colour the picker chose. Before the preview applies, `color`
  // still holds the old one, and setting the input back to it while the macOS picker is
  // open makes WebKit fire `change` with the old colour, which undid the choice.
  const [picked, setPicked] = useState<{ value: string; hex: string } | null>(null);
  const shownColor = flat(color);
  const hex = picked && picked.value === value ? picked.hex : shownColor ? toHex(shownColor) : "#000000";
  const pick = (raw: string) => {
    const next = raw.toUpperCase();
    if (next === hex.toUpperCase()) return;
    const chosen = token.kind === "triple" ? toTriple(parseColor(next)!) : next;
    setPicked({ value: chosen, hex: next });
    onChange(chosen);
  };
  const valid = value === undefined || validTokenValue(token, value);
  const changed = value !== startValue;
  // A setting's name is in the description; the field only has room to say that it follows.
  const placeholder = follows ? `Follows ${followsLabel}${token.fallback?.alpha ? ` at ${Math.round(token.fallback.alpha * 100)}%` : ""}` : token.followsSetting ? "Follows the setting" : "Colour";
  const id = `theme-token-${token.name}`;
  return (
    <div className="flex min-h-12 items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-body">{token.label}</label>
        <div className="mt-0.5 text-caption text-muted-foreground">
          {token.description}
          {ratio !== null ? (
            <span className={cn("tabular-nums", ratio < enough && "text-warning")}>
              {" "}· Contrast {ratio.toFixed(1)}:1{ratio < enough ? (token.shape ? ", hard to see" : ", hard to read") : ""}
            </span>
          ) : null}
        </div>
      </div>
      <input
        type="color"
        aria-label={`${token.label}: pick a colour`}
        value={hex}
        onChange={(event) => pick(event.currentTarget.value)}
        className="h-8 w-10 shrink-0 cursor-pointer rounded-control border border-input bg-transparent p-0.5"
      />
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        aria-invalid={!valid || undefined}
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => onChange(text.trim() ? text.trim() : canFollow ? undefined : startValue)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur();
        }}
        className={cn("h-8 w-40 shrink-0 font-mono text-small placeholder:font-sans", !valid && "border-destructive")}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={canFollow ? `${token.label}: follow ${followsLabel} again` : `${token.label}: put back`}
        title={canFollow ? "Follow again" : "Put back"}
        disabled={canFollow ? value === undefined : !changed}
        onClick={() => onChange(canFollow ? undefined : startValue)}
      >
        <RotateCcw className="h-4 w-4" />
      </Button>
    </div>
  );
}

