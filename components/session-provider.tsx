"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import type { ApprovalDecision, ApprovalRequest } from "@/approvals/types";
import type { ActivityEntry, ServerEvent, StatusLevel, StepLine, UiContent } from "@/events/types";
import { api, errorMessage } from "@/lib/client";
import { WALLET_UNLOCK_REQUESTED_EVENT } from "@/lib/wallet-types";
import type { Mode } from "@/lib/modes";

export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "output"; content: UiContent }
  | { id: string; kind: "steps"; title: string; steps: StepLine[]; footer?: string }
  | { id: string; kind: "activity"; entries: ActivityEntry[]; ended: boolean }
  | { id: string; kind: "plan"; summary: string; mode: Mode; externalFields: { field: string; source: string }[] }
  | { id: string; kind: "status"; level: StatusLevel; text: string }
  | { id: string; kind: "approval"; request: ApprovalRequest; decision: ApprovalDecision | null; selected?: number[] };

type NewItem = ChatItem extends infer I ? (I extends ChatItem ? Omit<I, "id"> : never) : never;

type Action =
  | { type: "add"; item: ChatItem }
  | { type: "activity"; group: string; entry: ActivityEntry }
  | { type: "activity_end"; group: string }
  | { type: "approvals"; requests: ApprovalRequest[] }
  | { type: "resolved"; id: string; decision: ApprovalDecision; selected?: number[] };

function reducer(items: ChatItem[], action: Action): ChatItem[] {
  switch (action.type) {
    case "add":
      return [...items, action.item];
    case "activity": {
      // One activity block per request; lines with the same id are updated in place.
      const index = items.findIndex((item) => item.id === action.group);
      if (index === -1) return [...items, { id: action.group, kind: "activity", entries: [action.entry], ended: false }];
      return items.map((item, i) => {
        if (i !== index || item.kind !== "activity") return item;
        const at = item.entries.findIndex((entry) => entry.id === action.entry.id);
        const entries = at === -1 ? [...item.entries, action.entry] : item.entries.map((entry, j) => (j === at ? action.entry : entry));
        return { ...item, entries };
      });
    }
    case "activity_end":
      return items.map((item) => (item.id === action.group && item.kind === "activity" ? { ...item, ended: true } : item));
    case "approvals": {
      const known = new Set(items.map((item) => item.id));
      const added = action.requests
        .filter((request) => !known.has(request.id))
        .map((request): ChatItem => ({ id: request.id, kind: "approval", request, decision: null }));
      return added.length ? [...items, ...added] : items;
    }
    case "resolved":
      return items.map((item) =>
        item.kind === "approval" && item.id === action.id && item.decision === null
          ? { ...item, decision: action.decision, selected: action.selected }
          : item,
      );
  }
}

type SessionValue = {
  items: ChatItem[];
  /** True while a message is being worked on. */
  busy: boolean;
  /** pasted: some of the text came from the clipboard or a drop, however short. */
  send: (text: string, options?: { pasted?: boolean }) => void;
  /** selected: plan cards only, the step indexes left ticked. */
  decide: (id: string, decision: "approved" | "rejected" | "keep", selected?: number[]) => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

// One session per browser tab. The id is not a secret; it only routes events to this tab.
const SESSION_KEY = "session-id";
let fallbackSessionId: string | undefined;

function readSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return (fallbackSessionId ??= crypto.randomUUID());
  }
}

const noSubscription = () => () => {};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const sessionId = useSyncExternalStore(noSubscription, readSessionId, () => null);
  const [items, dispatch] = useReducer(reducer, []);
  const [busy, setBusy] = useState(false);

  const add = useCallback(
    (item: NewItem) => dispatch({ type: "add", item: { ...item, id: crypto.randomUUID() } as ChatItem }),
    [],
  );

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`/api/events?session=${sessionId}`);

    // Runs on every (re)connect, so approvals raised while disconnected still appear.
    source.onopen = () => {
      api<ApprovalRequest[]>("GET", `/api/approvals?session=${sessionId}`)
        .then((requests) => dispatch({ type: "approvals", requests }))
        .catch(() => {});
    };

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ServerEvent;
      switch (event.type) {
        case "message":
          return add({ kind: "assistant", text: event.text });
        case "output":
          return add({ kind: "output", content: event.content });
        case "status":
          return add({ kind: "status", level: event.level, text: event.text });
        case "steps":
          return add({ kind: "steps", title: event.title, steps: event.steps, footer: event.footer });
        case "activity":
          return dispatch({ type: "activity", group: event.group, entry: event.entry });
        case "activity_end":
          return dispatch({ type: "activity_end", group: event.group });
        case "unlock_required":
          window.dispatchEvent(new Event(WALLET_UNLOCK_REQUESTED_EVENT));
          return;
        case "busy":
          return setBusy(event.busy);
        case "code_result":
          return add({ kind: "plan", summary: event.summary, mode: event.mode, externalFields: event.externalFields });
        case "approval_request":
          return dispatch({ type: "approvals", requests: [event.request] });
        case "approval_resolved":
          return dispatch({ type: "resolved", id: event.id, decision: event.decision, selected: event.selected });
      }
    };

    return () => source.close();
  }, [sessionId, add]);

  const value = useMemo<SessionValue>(() => {
    const post = (url: string, body: object) =>
      api("POST", url, { sessionId, ...body }).catch((error) =>
        add({ kind: "status", level: "error", text: errorMessage(error) }),
      );
    return {
      items,
      busy,
      send: (text, options) => {
        add({ kind: "user", text });
        void post("/api/chat", { text, pasted: Boolean(options?.pasted) });
      },
      decide: async (id, decision, selected) => {
        await post(`/api/approvals/${id}`, selected ? { decision, selected } : { decision });
      },
    };
  }, [items, busy, sessionId, add]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
