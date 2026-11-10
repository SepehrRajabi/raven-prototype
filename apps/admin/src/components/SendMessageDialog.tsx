import { useState } from "react";
import type { FormEvent } from "react";
import type { AdminApi } from "../api";
import { errorMessage } from "../lib/useLoad";
import { Button, Dialog, Field, Notice, Select, Textarea } from "./ui";
import { sendResult } from "../lib/sendResult";

const MAX = 1000;

export interface MessageAudience {
  label: string;
  to: "all" | string[];
}

/**
 * Sends a plain-text message from the server admin to people's Raven contact. Sending to
 * everyone asks once more, since it cannot be taken back.
 */
export function SendMessageDialog({ api, title, audiences, onClose }: { api: AdminApi; title: string; audiences: MessageAudience[]; onClose: () => void }) {
  const [choice, setChoice] = useState(0);
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const audience = audiences[choice];
  const trimmed = text.trim();

  const send = async () => {
    setBusy(true);
    setError("");
    try {
      const { sent, skipped } = await api.sendMessage(audience.to, trimmed);
      setResult(sendResult(sent, skipped));
    } catch (cause) {
      setError(errorMessage(cause));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    if (audience.to === "all" && !confirming) setConfirming(true);
    else void send();
  };

  if (result) {
    return (
      <Dialog title={title} onClose={onClose}>
        <div className="grid gap-4">
          <p className="text-body" role="status">{result}</p>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="grid gap-4" onSubmit={submit}>
        <p className="text-body text-muted-foreground">It arrives from Raven, in a conversation people cannot reply to. It is plain text. People who turned Raven messages off do not get it.</p>
        {audiences.length > 1 ? (
          <Field label="Send to">
            {(id) => (
              <Select id={id} value={choice} onChange={(event) => { setChoice(Number(event.target.value)); setConfirming(false); }}>
                {audiences.map((each, index) => <option key={each.label} value={index}>{each.label}</option>)}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label="Message" hint={`${text.length} of ${MAX}`}>
          {(id) => <Textarea id={id} value={text} maxLength={MAX} onChange={(event) => { setText(event.target.value); setConfirming(false); }} required />}
        </Field>
        {confirming ? <Notice tone="warning">This goes to everyone with an account. It cannot be taken back.</Notice> : null}
        {error ? <Notice>{error}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !trimmed}>
            {busy ? "Sending…" : confirming ? "Send to everyone" : "Send"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
