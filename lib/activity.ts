import { randomUUID } from "node:crypto";
import type { ActivityPort } from "@/ai/ports";
import { publish } from "@/events/bus";
import type { ActivityEntry } from "@/events/types";

const MAX_TEXT = 120;
const clean = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);

/**
 * One request's activity stream: lines the user sees while the request runs.
 * Written by the app's own code ("system"), except program steps, which are the
 * generated program's narration and are shown as such.
 */
export class Activity implements ActivityPort {
  readonly group = randomUUID();
  #entries = new Map<string, ActivityEntry>();
  #programStep: string | null = null;
  #suppressProgram = false;

  constructor(private readonly sessionId: string) {}

  #emit(entry: ActivityEntry) {
    this.#entries.set(entry.id, entry);
    publish(this.sessionId, { type: "activity", group: this.group, entry });
  }

  #update(id: string, changes: Partial<ActivityEntry>) {
    const entry = this.#entries.get(id);
    if (entry) this.#emit({ ...entry, ...changes, text: changes.text ? clean(changes.text) : entry.text });
  }

  start(text: string, options: { level?: "step" | "detail"; source?: "system" | "program" } = {}): string {
    const id = randomUUID();
    this.#emit({ id, text: clean(text), state: "running", source: options.source ?? "system", level: options.level ?? "step" });
    return id;
  }

  done(id: string, text?: string, detail?: string): void {
    this.#update(id, { state: "done", ...(text ? { text } : {}), ...(detail ? { detail: clean(detail) } : {}) });
  }

  fail(id: string, detail?: string): void {
    this.#update(id, { state: "failed", ...(detail ? { detail: clean(detail) } : {}) });
  }

  wait(text: string): string {
    const id = randomUUID();
    this.#emit({ id, text: clean(text), state: "waiting", source: "system", level: "step" });
    return id;
  }

  info(text: string, options: { level?: "step" | "detail" } = {}): void {
    this.#emit({ id: randomUUID(), text: clean(text), state: "info", source: "system", level: options.level ?? "step" });
  }

  /**
   * A step narrated by the program (ui.step). The previous program step is
   * marked done when the next one starts, or when the program finishes.
   */
  programStep(text: string): void {
    if (this.#suppressProgram) return;
    this.finishProgramStep();
    this.#programStep = this.start(text, { source: "program" });
  }

  finishProgramStep(state: "done" | "failed" = "done"): void {
    if (!this.#programStep) return;
    if (state === "done") this.done(this.#programStep);
    else this.fail(this.#programStep);
    this.#programStep = null;
  }

  /** Whether program steps are currently hidden. */
  get programStepsSuppressed(): boolean {
    return this.#suppressProgram;
  }

  /** While true, program steps are not shown (the second run of a program repeats the first). */
  suppressProgramSteps(suppress: boolean): void {
    this.#suppressProgram = suppress;
  }

  /** Marks anything still running as done and closes the stream. */
  end(): void {
    this.finishProgramStep();
    for (const entry of this.#entries.values()) {
      if (entry.state === "running" || entry.state === "waiting") this.#emit({ ...entry, state: "done" });
    }
    publish(this.sessionId, { type: "activity_end", group: this.group });
  }
}

/** The parts of an activity stream the access layer uses. */
export type PlanActivity = Pick<
  Activity,
  "start" | "done" | "fail" | "wait" | "info" | "programStep" | "finishProgramStep" | "suppressProgramSteps" | "programStepsSuppressed"
>;

/** Used when nobody is watching (tests, scripts). */
export const noActivity: PlanActivity = {
  start: () => "",
  done: () => {},
  fail: () => {},
  wait: () => "",
  info: () => {},
  programStep: () => {},
  finishProgramStep: () => {},
  suppressProgramSteps: () => {},
  programStepsSuppressed: false,
};
