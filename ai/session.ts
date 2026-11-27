import { MAX_CONVERSATION_TURNS } from "./config";
import type { Turn } from "./state";

/**
 * What the AI layer remembers about a chat, in server memory only.
 *
 * Only trusted history carries over between requests (see contextFor): the
 * user's typed messages, and records of what the access layer actually did,
 * written from fixed templates. Pasted text, the planner's questions and
 * anything the model wrote stay with the request they belong to, so planted
 * "earlier conversation" or a steered summary can never reach a later request.
 * Results of running code (balances, history) never enter it.
 */
export type AiSession = {
  turns: Turn[];
  clarificationRounds: number;
  /** The user's messages for the current request, including answers to clarifications. */
  requestTexts: string[];
  /** Number of the current request. */
  request: number;
};

const globalForSessions = globalThis as unknown as { __aiSessions?: Map<string, AiSession> };
const sessions = (globalForSessions.__aiSessions ??= new Map());

export function getAiSession(sessionId: string): AiSession {
  let session = sessions.get(sessionId);
  if (!session) sessions.set(sessionId, (session = { turns: [], clarificationRounds: 0, requestTexts: [], request: 0 }));
  return session;
}

/** Forgets a session's conversation. Its placeholders mean nothing once the encoder's mapping is cleared. */
export function clearAiSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function addTurn(session: AiSession, turn: Turn): void {
  session.turns.push({ request: session.request, ...turn });
  if (session.turns.length > MAX_CONVERSATION_TURNS) {
    session.turns.splice(0, session.turns.length - MAX_CONVERSATION_TURNS);
  }
}

/** Records what the access layer did for the current request. Written from templates, never by a model. */
export function addRecord(session: AiSession, text: string): void {
  addTurn(session, { role: "assistant", text, kind: "record" });
}

/** Kinds of turn that may be shown to the model in later requests. */
const CARRIES_OVER = new Set(["typed", "record"]);

/**
 * The conversation the model sees for the current request: everything from this
 * request, plus only trusted turns from earlier ones.
 */
export function contextFor(session: AiSession): Turn[] {
  return session.turns.filter(
    (turn) => turn.request === session.request || CARRIES_OVER.has(turn.kind ?? (turn.role === "user" ? "typed" : "")),
  );
}
