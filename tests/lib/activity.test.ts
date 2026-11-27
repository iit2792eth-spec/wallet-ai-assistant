import { describe, expect, it } from "vitest";
import { subscribe } from "@/events/bus";
import type { ActivityEntry, ServerEvent } from "@/events/types";
import { Activity } from "@/lib/activity";

function collect(sessionId: string) {
  const events: ServerEvent[] = [];
  subscribe(sessionId, (event) => events.push(event));
  const latest = () => {
    const lines = new Map<string, ActivityEntry>();
    for (const e of events) if (e.type === "activity") lines.set(e.entry.id, e.entry);
    return [...lines.values()];
  };
  return { events, latest };
}

describe("activity stream", () => {
  it("updates a line in place from running to done", () => {
    const { latest } = collect("act-1");
    const activity = new Activity("act-1");
    const id = activity.start("Checking balances");
    activity.done(id, undefined, "All 2 steps can be completed");
    expect(latest()).toEqual([{ id, text: "Checking balances", state: "done", source: "system", level: "step", detail: "All 2 steps can be completed" }]);
  });

  it("marks the previous program step done when the next starts, and hides steps while suppressed", () => {
    const { latest } = collect("act-2");
    const activity = new Activity("act-2");
    activity.programStep("Reading your balance");
    activity.programStep("Preparing the transfer");
    activity.suppressProgramSteps(true);
    activity.programStep("Reading your balance"); // a repeat from the second run
    activity.suppressProgramSteps(false);
    activity.finishProgramStep();
    expect(latest().map((e) => [e.text, e.state, e.source])).toEqual([
      ["Reading your balance", "done", "program"],
      ["Preparing the transfer", "done", "program"],
    ]);
  });

  it("closes the stream and finishes anything still running", () => {
    const { events, latest } = collect("act-3");
    const activity = new Activity("act-3");
    activity.start("Running the program");
    activity.wait("Waiting for your approval");
    activity.end();
    expect(latest().every((e) => e.state === "done")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "activity_end", group: activity.group });
  });

  it("keeps lines to one short line", () => {
    const { latest } = collect("act-4");
    new Activity("act-4").info(`a\n${"b".repeat(300)}`);
    expect(latest()[0].text.length).toBeLessThanOrEqual(120);
    expect(latest()[0].text).not.toContain("\n");
  });
});
