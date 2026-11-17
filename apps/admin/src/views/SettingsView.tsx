import { useEffect, useState } from "react";
import type { AdminApi } from "../api";
import type { AccountSettings, CapabilityDefault, CapabilityName } from "../types";
import { Button, Input, List, Loading, Notice, PageHeader, Row, Section, Select } from "../components/ui";
import { CAPABILITY_LIMITS, capabilityText } from "../lib/format";
import { IMAGE_TYPES, imageProblem } from "../lib/image";
import { errorMessage, useLoad } from "../lib/useLoad";

export function SettingsView({ api }: { api: AdminApi }) {
  const loaded = useLoad(() => api.capabilityDefaults(), "capability-defaults");
  const [draft, setDraft] = useState<CapabilityDefault[] | null>(null);
  const [limits, setLimits] = useState<Partial<Record<CapabilityName, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDraft(loaded.data);
    setLimits(currentLimits(loaded.data));
  }, [loaded.data]);

  const changed = draft !== null && loaded.data !== null && (JSON.stringify(draft) !== JSON.stringify(loaded.data) || JSON.stringify(limits) !== JSON.stringify(currentLimits(loaded.data)));

  const save = async () => {
    if (!draft) return;
    const parsed: Partial<Record<CapabilityName, number | null>> = {};
    for (const [capability, text] of Object.entries(limits) as Array<[CapabilityName, string]>) {
      const value = text.trim() === "" ? null : Number.parseInt(text, 10);
      if (value !== null && (!Number.isFinite(value) || value < 1)) {
        setError("A limit must be a whole number of 1 or more, or empty for no limit.");
        return;
      }
      parsed[capability] = value;
    }
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const next = await api.setCapabilityDefaults(draft.map((item) => (item.capability in parsed ? { ...item, limit: item.allowed ? (parsed[item.capability] ?? null) : null } : item)));
      loaded.set(next);
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="What applies to the whole server." />
      <WhoCanJoin api={api} />
      <Section
        title="Default permissions"
        description="What an account may do unless it has its own setting. A new account starts with these. Administrators are never limited."
        actions={
          <Button variant="primary" size="sm" disabled={!changed || busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        }
      >
        {loaded.error ? <Notice>{loaded.error}</Notice> : null}
        {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
        {saved && !changed ? <div className="mb-3"><Notice tone="neutral">Saved. It applies to everyone signed in now.</Notice></div> : null}
        {draft ? (
          <List>
            {draft.map((item) => {
              const text = capabilityText(item.capability);
              return (
                <Row key={item.capability}>
                  <div className="min-w-0 flex-1 py-1">
                    <p className="font-medium">{text.title}</p>
                    {text.description ? <p className="text-small text-muted-foreground">{text.description}</p> : null}
                  </div>
                  {CAPABILITY_LIMITS[item.capability] && item.allowed ? (
                    <Input
                      className="w-24"
                      inputMode="numeric"
                      aria-label={CAPABILITY_LIMITS[item.capability]?.label}
                      placeholder="No limit"
                      value={limits[item.capability] ?? ""}
                      onChange={(event) => {
                        setLimits({ ...limits, [item.capability]: event.target.value });
                        setSaved(false);
                      }}
                    />
                  ) : null}
                  <Select
                    aria-label={text.title}
                    value={item.allowed ? "allow" : "deny"}
                    onChange={(event) => {
                      setSaved(false);
                      setDraft(draft.map((other) => (other.capability === item.capability ? { ...other, allowed: event.target.value === "allow" } : other)));
                    }}
                  >
                    <option value="allow">Allowed</option>
                    <option value="deny">Not allowed</option>
                  </Select>
                </Row>
              );
            })}
          </List>
        ) : loaded.loading ? (
          <Loading />
        ) : null}
      </Section>
      <ServerImage api={api} />
    </>
  );
}

function currentLimits(defaults: CapabilityDefault[]): Partial<Record<CapabilityName, string>> {
  const limits: Partial<Record<CapabilityName, string>> = {};
  for (const item of defaults) {
    if (CAPABILITY_LIMITS[item.capability]) limits[item.capability] = item.limit == null ? "" : String(item.limit);
  }
  return limits;
}

const ACCOUNT_SWITCHES: Array<{ key: keyof AccountSettings; title: string; description: string }> = [
  { key: "signUpOpen", title: "Sign-up", description: "Anyone with the server’s address can create an account." },
  { key: "invitationsOpen", title: "Invitations", description: "People allowed to Invite people can give a friend a single-use code. Turning this off stops every open code." },
];

/** The server's two ways in that do not need an administrator to make the account. */
function WhoCanJoin({ api }: { api: AdminApi }) {
  const loaded = useLoad(() => api.accountSettings(), "account-settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = async (key: keyof AccountSettings, value: boolean) => {
    if (!loaded.data) return;
    setBusy(true);
    setError("");
    try {
      loaded.set(await api.setAccountSettings({ ...loaded.data, [key]: value }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Who can join" description="With both off, only an administrator can make accounts.">
      {loaded.error ? <Notice>{loaded.error}</Notice> : null}
      {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
      {loaded.data ? (
        <List>
          {ACCOUNT_SWITCHES.map((item) => (
            <Row key={item.key}>
              <div className="min-w-0 flex-1 py-1">
                <p className="font-medium">{item.title}</p>
                <p className="text-small text-muted-foreground">{item.description}</p>
              </div>
              <Select aria-label={item.title} value={loaded.data?.[item.key] ? "on" : "off"} disabled={busy} onChange={(event) => void toggle(item.key, event.target.value === "on")}>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </Row>
          ))}
        </List>
      ) : loaded.loading ? (
        <Loading />
      ) : null}
    </Section>
  );
}

function ServerImage({ api }: { api: AdminApi }) {
  // The address changes after an upload so the browser fetches the new picture.
  const [version, setVersion] = useState(0);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const problem = imageProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.uploadServerImage(file);
      setMissing(false);
      setVersion((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Server image" description="Shown beside the server’s name in the Raven app.">
      {error ? <div className="mb-3"><Notice>{error}</Notice></div> : null}
      <div className="flex items-center gap-4 rounded-card bg-secondary/50 p-4">
        {missing ? (
          <div className="grid h-16 w-16 shrink-0 place-items-center rounded-card bg-accent text-caption text-subtle">None</div>
        ) : (
          <img src={`/v1/media/server/avatar?v=${version}`} alt="Current server image" className="h-16 w-16 shrink-0 rounded-card bg-accent object-cover" onError={() => setMissing(true)} />
        )}
        <p className="min-w-0 flex-1 text-small text-muted-foreground">A square PNG, JPEG or WebP, up to 512 KB.</p>
        <label className="inline-flex h-8 cursor-pointer items-center rounded-control bg-secondary px-3 text-small font-medium text-secondary-foreground hover:bg-accent has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
          {busy ? "Uploading…" : "Choose image"}
          <input type="file" accept={IMAGE_TYPES.join(",")} className="sr-only" disabled={busy} onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
      </div>
    </Section>
  );
}
