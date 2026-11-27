import { cancelPlan } from "@/access";
import { clearAiSession } from "@/ai/session";
import { clearVault } from "@/text-encoder";

// A session's mapping and conversation live in memory while a browser tab is
// connected. When the last tab disconnects they are cleared after a grace
// period, long enough to survive a page reload.

const GRACE_MS = 5 * 60 * 1000;

type Tracker = { connections: number; timer?: NodeJS.Timeout };
const globalForLifecycle = globalThis as unknown as { __sessionLifecycle?: Map<string, Tracker> };
const trackers = (globalForLifecycle.__sessionLifecycle ??= new Map());

export function endSession(sessionId: string): void {
  clearTimeout(trackers.get(sessionId)?.timer);
  trackers.delete(sessionId);
  cancelPlan(sessionId);
  clearVault(sessionId);
  clearAiSession(sessionId);
}

export function sessionConnected(sessionId: string): void {
  const tracker = trackers.get(sessionId) ?? { connections: 0 };
  clearTimeout(tracker.timer);
  tracker.timer = undefined;
  tracker.connections += 1;
  trackers.set(sessionId, tracker);
}

export function sessionDisconnected(sessionId: string): void {
  const tracker = trackers.get(sessionId);
  if (!tracker) return;
  tracker.connections = Math.max(0, tracker.connections - 1);
  if (tracker.connections === 0) {
    tracker.timer = setTimeout(() => endSession(sessionId), GRACE_MS);
    tracker.timer.unref?.();
  }
}
