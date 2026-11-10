import { memo, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { emojiOnlyCount, parseMessage, type Inline } from "@/lib/chat/format";
import { removedNestText, type MentionResolver, type MentionTarget } from "@/lib/chat/mentions";
import { cn } from "@/lib/utils";
import { NestGlyph, PresenceDot } from "@/shells/ravenv1/atoms";
import type { Presence } from "@/shells/ravenv1/state";

/** Opens a web address in the person's browser, never inside Raven's own window. */
export function openAddress(href: string) {
  void invoke("plugin:opener|open_url", { url: href }).catch(() => {
    // Not inside the desktop app (a browser preview): fall back to a new tab.
    window.open(href, "_blank", "noopener,noreferrer");
  });
}

function onLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  openAddress(event.currentTarget.href);
}

export interface MentionContext {
  resolve: MentionResolver;
  /** The reader, whose own name takes the accent. */
  me: string;
  onOpen?: (target: MentionTarget, id: string) => void;
}

/** A 12 or 14 px face that sits in a line of text. */
function Face({ id, name, presence, className }: { id: string; name: string; presence?: Presence; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-accent", className)} aria-hidden title={name}>
      {failed ? null : <img src={api.userAvatarUrl(id)} alt="" draggable={false} className="h-full w-full rounded-full object-cover" onError={() => setFailed(true)} />}
      {presence ? <PresenceDot presence={presence} className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 opacity-0 transition-opacity group-hover/mention:opacity-100" /> : null}
    </span>
  );
}

const gone = "italic text-muted-foreground";

/** A person is their face and name; a nest is a doorway holding its glyph and name. */
function Mention({ node, context }: { node: Extract<Inline, { type: "mention" }>; context?: MentionContext }) {
  if (node.target === "user") {
    const person = context?.resolve.person(node.id);
    if (!person || !context) {
      return (
        <span className={gone}>
          <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-subtle/60" />
          someone
        </span>
      );
    }
    const isMe = node.id === context.me;
    const inner = (
      <>
        <Face id={node.id} name={person.name} presence={person.presence} className="translate-y-[2px]" />
        <bdi className={cn("ml-1 font-medium decoration-subtle underline-offset-2 group-hover/mention:underline", isMe ? "text-live" : "text-foreground")}>{person.name}</bdi>
      </>
    );
    return context.onOpen ? (
      <button type="button" aria-label={`Open ${person.name}’s profile`} onClick={() => context.onOpen!(node.target, node.id)} className="group/mention inline rounded-chip text-start">
        {inner}
      </button>
    ) : <span className="group/mention">{inner}</span>;
  }

  const nest = context?.resolve.nest(node.target, node.id);
  if (!nest || !context) return <span className={gone}>{context ? removedNestText(context.resolve) : "…"}</span>;
  const live = nest.kind === "voice" && nest.people.length > 0;
  const faces = nest.people.slice(0, 3);
  const inner = (
    <>
      <NestGlyph kind={nest.kind} live={live} className={cn("h-3.5 w-3.5", live ? "text-live" : "text-subtle")} />
      <bdi className={cn("font-medium", nest.kind === "voice" && !live ? "text-muted-foreground" : "text-foreground")}>{nest.name}</bdi>
      {faces.length > 0 ? (
        <span className="ml-0.5 inline-flex items-center -space-x-1">
          {faces.map((person) => <Face key={person.id} id={person.id} name={person.name} className="h-3 w-3 ring-1 ring-card" />)}
        </span>
      ) : null}
      {nest.people.length > 3 ? <span className="text-caption text-muted-foreground">+{nest.people.length - 3}</span> : null}
    </>
  );
  const doorway = "mx-px inline-flex max-w-full translate-y-[3px] items-center gap-1 rounded-chip border border-subtle/50 px-1.5 align-baseline leading-5";
  return context.onOpen ? (
    <button type="button" aria-label={`Open ${nest.name}`} onClick={() => context.onOpen!(node.target, node.id)} className={cn(doorway, "transition-colors hover:border-subtle hover:bg-secondary/60")}>
      {inner}
    </button>
  ) : <span className={doorway}>{inner}</span>;
}

function renderInline(nodes: Inline[], keyPrefix = "", context?: MentionContext): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}${index}`;
    switch (node.type) {
      case "mention":
        return <Mention key={key} node={node} context={context} />;
      case "text":
        return node.text;
      case "bold":
        return <strong key={key} className="font-semibold">{renderInline(node.children, `${key}.`, context)}</strong>;
      case "italic":
        return <em key={key}>{renderInline(node.children, `${key}.`, context)}</em>;
      case "strike":
        return <s key={key}>{renderInline(node.children, `${key}.`, context)}</s>;
      case "code":
        return <code key={key} dir="ltr" className="rv-mono rounded-chip bg-card px-1 py-px text-small">{node.text}</code>;
      case "link":
        // The address is shown as written, left to right, so it reads the same in a
        // Persian sentence as in an English one.
        return (
          <a key={key} href={node.href} dir="ltr" title={node.href} onClick={onLinkClick} className="underline decoration-subtle underline-offset-2 hover:decoration-foreground">
            <bdi>{node.text}</bdi>
          </a>
        );
    }
  });
}

/**
 * The words of a message. Formatting is drawn from a parsed tree, so nothing a person
 * types is ever interpreted as markup.
 */
export const MessageText = memo(function MessageText({ body, className, mentions }: { body: string; className?: string; mentions?: MentionContext }) {
  const blocks = useMemo(() => parseMessage(body), [body]);
  const jumbo = useMemo(() => emojiOnlyCount(body), [body]);
  return (
    <div className={cn("raven-chat-text", ["text-body", "text-emoji-1", "text-emoji-2", "text-emoji-3"][jumbo], className)}>
      {blocks.map((block, index) =>
        block.type === "code" ? (
          <pre key={index} dir="ltr" className="rv-mono my-1 overflow-x-auto whitespace-pre rounded-control bg-card px-2.5 py-2 text-small">
            {block.text}
          </pre>
        ) : (
          <p key={index} dir="auto">{renderInline(block.children, "", mentions)}</p>
        ),
      )}
    </div>
  );
});
