import { useRef, useState } from "react";
import type { AdminApi, AuditPage } from "../api";
import type { AuditEvent } from "../types";
import { Button, List, Loading, Notice, PageHeader, Row, Select } from "../components/ui";
import { describeAction, describeDetail, formatDateTime } from "../lib/format";
import { routeHref } from "../lib/route";
import { errorMessage, useLoad } from "../lib/useLoad";

export function AuditView({ api }: { api: AdminApi }) {
  const [entityType, setEntityType] = useState("");
  const [older, setOlder] = useState<AuditEvent[]>([]);
  // Where the next "Show older" starts once an older page has arrived; until then the first
  // page says. Null means there is nothing older.
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Bumped whenever the list starts over, so an older page that was asked for under the
  // previous filter is dropped when it arrives instead of being added to this one.
  const generation = useRef(0);
  const first = useLoad<AuditPage>(async () => {
    generation.current += 1;
    setOlder([]);
    setCursor(undefined);
    setBusy(false);
    setError("");
    return api.auditPage({ entityType });
  }, entityType);
  const firstEvents = first.data?.events ?? [];
  const events = [...firstEvents, ...older];
  const before = cursor === undefined ? (first.data?.before ?? null) : cursor;
  const more = async () => {
    if (!before) return;
    const asked = generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await api.auditPage({ entityType, before });
      if (generation.current !== asked) return;
      setOlder((current) => {
        // A cursor that includes its boundary would repeat an event; show it once.
        const seen = new Set([...firstEvents, ...current].map((event) => event.id));
        return [...current, ...page.events.filter((event) => !seen.has(event.id))];
      });
      setCursor(page.events.length > 0 ? page.before : null);
    } catch (cause) {
      if (generation.current === asked) setError(errorMessage(cause));
    } finally {
      if (generation.current === asked) setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Audit log" description="Every change made from this dashboard or the server’s command line, and every change of a space’s owner. Entries cannot be edited or removed." />
      <div className="mb-4">
        <Select aria-label="Show" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
          <option value="">Everything</option>
          <option value="user">Users</option>
          <option value="space">Spaces</option>
          <option value="room">Rooms</option>
          <option value="invite">Invites</option>
          <option value="library_item">GIFs and stickers</option>
          <option value="server">Server settings and messages</option>
        </Select>
      </div>
      {first.error ? <Notice>{first.error}</Notice> : null}
      {first.data ? (
        <List empty="Nothing has been recorded yet.">
          {events.map((event) => (
            <Row key={event.id}>
              <div className="min-w-0 flex-1 py-1">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{describeAction(event.action)}</span>
                  <Subject event={event} />
                </p>
                {describeDetail(event.detail) ? <p className="break-words text-small text-subtle">{describeDetail(event.detail)}</p> : null}
              </div>
              <div className="shrink-0 text-right text-small">
                <p className="text-muted-foreground">{event.actorLabel === "cli" ? "Command line" : `@${event.actorLabel}`}</p>
                <p className="text-subtle">{formatDateTime(event.createdAt)}</p>
              </div>
            </Row>
          ))}
        </List>
      ) : first.loading ? (
        <Loading />
      ) : null}
      {error ? <div className="mt-3"><Notice>{error}</Notice></div> : null}
      {first.data && before ? (
        <div className="mt-4 flex justify-center">
          <Button size="sm" disabled={busy} onClick={() => void more()}>
            {busy ? "Loading…" : "Show older"}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function Subject({ event }: { event: AuditEvent }) {
  const label = event.entityLabel || event.entityId;
  if (!label) return null;
  if (event.entityType === "user") {
    // A deleted account keeps its page, but its name is gone: the label is a placeholder.
    return (
      <a href={routeHref({ page: "user", id: event.entityId })} className="text-muted-foreground hover:underline">
        {event.action === "account.deleted" ? label : `@${label}`}
      </a>
    );
  }
  // A deleted space has no page to open.
  if (event.entityType === "space" && event.action !== "space.deleted") {
    return (
      <a href={routeHref({ page: "space", id: event.entityId })} className="text-muted-foreground hover:underline">
        {label}
      </a>
    );
  }
  return <span className="text-muted-foreground">{label}</span>;
}
