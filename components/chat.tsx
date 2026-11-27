"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { ApprovalCard } from "@/components/approval-card";
import { SlippageCard } from "@/components/slippage-card";
import { ActivityStream } from "@/components/activity-stream";
import { InjectionCard } from "@/components/injection-card";
import { OutputCard } from "@/components/output-card";
import { StepsCard } from "@/components/steps-card";
import { useSession, type ChatItem } from "@/components/session-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MODE_LABELS } from "@/lib/modes";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const STATUS_COLORS = {
  info: "text-muted-foreground",
  success: "text-success",
  error: "text-destructive",
} as const;

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="max-w-[80%] self-end rounded-lg bg-secondary px-3 py-2 text-sm whitespace-pre-wrap">
          {item.text}
        </div>
      );
    case "assistant":
      return <p className="text-sm whitespace-pre-wrap">{item.text}</p>;
    case "output":
      return <OutputCard content={item.content} />;
    case "activity":
      return <ActivityStream entries={item.entries} ended={item.ended} />;
    case "steps":
      return <StepsCard title={item.title} steps={item.steps} footer={item.footer} />;
    case "plan":
      return (
        <div className="rounded-lg border bg-card text-sm">
          <div className="flex items-start justify-between gap-3 px-4 py-2.5">
            <p className="whitespace-pre-wrap">{item.summary}</p>
            <Badge variant={item.mode === "sign" ? "secondary" : "outline"} className="shrink-0">
              {MODE_LABELS[item.mode]}
            </Badge>
          </div>
          {item.externalFields.length > 0 && (
            <dl className="border-t px-4 py-2.5">
              <dt className="pb-1 text-xs text-warning">From external sources</dt>
              {item.externalFields.map((field, index) => (
                <dd key={index} className="flex gap-2 text-xs">
                  <span>{field.field}</span>
                  <span className="break-all text-muted-foreground">{field.source}</span>
                </dd>
              ))}
            </dl>
          )}
        </div>
      );
    case "status":
      return <p className={cn("text-xs", STATUS_COLORS[item.level])}>{item.text}</p>;
    case "approval":
      return item.request.kind === "injection_review" ? (
        <InjectionCard request={item.request} decision={item.decision} />
      ) : item.request.kind === "slippage_confirm" ? (
        <SlippageCard request={item.request} decision={item.decision} />
      ) : (
        <ApprovalCard request={item.request} decision={item.decision} selected={item.selected} />
      );
  }
}

export function Chat() {
  const { items, busy, send } = useSession();
  const [text, setText] = useState("");
  // Set when any of the message was pasted or dropped in, however little: the server then treats
  // the whole message as pasted text (checked for injected instructions, addresses not "typed by you").
  const [pasted, setPasted] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, busy]);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    send(trimmed, { pasted });
    setText("");
    setPasted(false);
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {busy && !items.some((item) => item.kind === "activity" && !item.ended) && (
          <p className="text-xs text-muted-foreground">
            {items.some((item) => item.kind === "approval" && item.decision === null) ? "Waiting for your approval…" : "Working…"}
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex flex-col gap-2 p-6 pt-0">
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Textarea
            aria-label="Message"
            placeholder="Message"
            rows={1}
            className="max-h-40 min-h-9 resize-none"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              if (!event.target.value) setPasted(false);
            }}
            onPaste={() => setPasted(true)}
            onDrop={() => setPasted(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button type="submit" size="icon-lg" aria-label="Send" disabled={busy || !text.trim()}>
            <ArrowUp />
          </Button>
        </form>
      </div>
    </div>
  );
}
