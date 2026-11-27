import type { ServerEvent } from "./types";

type Listener = (event: ServerEvent) => void;

// Kept on globalThis so every route handler shares one bus, including across dev reloads.
const globalForBus = globalThis as unknown as { __eventBus?: Map<string, Set<Listener>> };
const listeners = (globalForBus.__eventBus ??= new Map());

export function subscribe(sessionId: string, listener: Listener): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

export function publish(sessionId: string, event: ServerEvent): void {
  for (const listener of listeners.get(sessionId) ?? []) listener(event);
}
