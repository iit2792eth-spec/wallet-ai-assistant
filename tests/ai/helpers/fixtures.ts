import type { AiDeps } from "@/ai/deps";
import { Manifest, loadManifest } from "@/ai/manifest";
import type { ChatMessage, ModelPort, ModelTask } from "@/ai/ports";
import { MaskVault } from "@/text-encoder";
import type { RawTools } from "@/ai/subagents/tools";

export const ADDRESS_A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const ADDRESS_B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

export const manifest = loadManifest();

/** BLOCKCHAIN_FUNCTIONS = []: only the core primitives exist. */
export const emptyManifest = new Manifest({
  version: 1,
  functions: manifest.data.functions.filter((fn) => fn.kind !== "read"),
  actions: [],
  types: {},
});

type Reply = string | ((messages: ChatMessage[]) => string);
export type ScriptedModel = ModelPort & { calls: { task: ModelTask; messages: ChatMessage[] }[] };

/**
 * A fake model that returns prepared replies per task, in order. The last reply
 * for a task repeats. Records every call so tests can inspect what a model was sent.
 */
export function scriptedModel(script: Partial<Record<ModelTask, Reply[]>>): ScriptedModel {
  const position: Partial<Record<ModelTask, number>> = {};
  const calls: ScriptedModel["calls"] = [];
  return {
    calls,
    async invoke(task, messages) {
      calls.push({ task, messages: messages.map((message) => ({ ...message })) });
      const replies = script[task];
      if (!replies?.length) throw new Error(`No scripted reply for task "${task}"`);
      const index = Math.min(position[task] ?? 0, replies.length - 1);
      position[task] = index + 1;
      const reply = replies[index];
      return typeof reply === "function" ? reply(messages) : reply;
    },
  };
}

export function makeDeps(model: ModelPort, overrides: Partial<AiDeps> = {}): AiDeps & { encoder: MaskVault } {
  const noTools: RawTools = {
    fetchWebText: async () => {
      throw new Error("No network in tests");
    },
    extractPdfText: async () => {
      throw new Error("No files in tests");
    },
  };
  return { model, encoder: new MaskVault(), manifest, rawTools: noTools, ...overrides } as AiDeps & {
    encoder: MaskVault;
  };
}

export const json = (value: unknown) => JSON.stringify(value);

export const completePlan = (overrides: Record<string, unknown> = {}) =>
  json({
    status: "complete",
    mode: "sign",
    steps: [{ id: 1, description: "Do what the user asked", functions: ["propose"], depends_on: [] }],
    computed_amounts: [],
    required_functions: ["propose"],
    units: ["ETH"],
    external_data: [],
    summary: "Do what the user asked.",
    ...overrides,
  });

export const coderReply = (code: string, functionsUsed: string[], externalFields: unknown[] = []) =>
  json({ code, summary: "Does what the user asked.", functions_used: functionsUsed, external_fields: externalFields });

export const NO_ERRORS = json({ errors: [] });

let counter = 0;
export const newSessionId = () => `test-session-${++counter}`;

type Pay = { recipient: string; amount: string; unit: string };

/**
 * A fake extraction model for the segment format (ai/subagents/extract.ts): it
 * reads the numbered segments it was sent and answers each one it was asked
 * about with `pay(text)`, or, if that returns nothing, sets it aside.
 * A fields-only request (no segments) gets `fields`.
 */
export function segmentAnswerer(pay: (text: string, segment: number) => Pay[], fields: { name: string; value: string }[] = []) {
  return (messages: ChatMessage[]) => {
    const content = messages.at(-1)!.content;
    const ask = /Answer for: (.*)/.exec(content)?.[1];
    if (!ask) return JSON.stringify({ fields });
    const texts = new Map([...content.matchAll(/^\[S(\d+)\] (.*)$/gm)].map((m) => [Number(m[1]), m[2]]));
    const answers = ask.split(", ").map((label) => {
      const segment = Number(label.slice(1));
      const payments = pay(texts.get(segment) ?? "", segment);
      return payments.length ? { segment, payments } : { segment, payments: [], reason: "information" };
    });
    return JSON.stringify({ fields, answers });
  };
}

/** The first address placeholder in a segment. */
export const firstPlaceholder = (text: string) => /\[(?:WALLET_ADDRESS|ENS_NAME)_\d+\]/.exec(text)?.[0] ?? "";
