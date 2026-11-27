import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { Client } from "langsmith";
import { createAnonymizer } from "langsmith/anonymizer";
import { redact } from "@/lib/logger";

// Optional LangSmith tracing for developing and testing the AI layer.
//
// Off unless AI_TRACING=langsmith. When on, traces of the AI layer (masked
// prompts, plans, code drafts, verifier errors) are uploaded to LangSmith,
// a third party. This is outside the network policy in docs/AI_layer.txt,
// so use it for development and tests only.
//
// Every value is passed through redact() before upload, as a second line of
// defence behind the Text Encoder: raw keys, addresses and emails never leave.

const DEFAULT_PROJECT = "wallet-access-layer";

// LangChain's own automatic tracing would upload without our redaction. It is
// switched off here so the only tracer is the one below.
for (const name of ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"]) {
  if (process.env[name] && process.env[name] !== "false") {
    console.warn(`[tracing] ${name} is ignored. Use AI_TRACING=langsmith, which redacts traces before upload.`);
    process.env[name] = "false";
  }
}

let client: Client | undefined;

export function tracingEnabled(): boolean {
  return process.env.AI_TRACING === "langsmith" && Boolean(process.env.LANGSMITH_API_KEY);
}

function getClient(): Client {
  return (client ??= new Client({
    apiKey: process.env.LANGSMITH_API_KEY,
    ...(process.env.LANGSMITH_ENDPOINT ? { apiUrl: process.env.LANGSMITH_ENDPOINT } : {}),
    anonymizer: createAnonymizer((value) => redact(value)),
  }));
}

/** Callbacks to pass to a graph run. Empty when tracing is off. */
export function tracingCallbacks(): BaseCallbackHandler[] {
  if (!tracingEnabled()) return [];
  return [new LangChainTracer({ client: getClient(), projectName: process.env.LANGSMITH_PROJECT || DEFAULT_PROJECT })];
}

/** Waits until traces are uploaded. Needed before a short-lived process (a test run) exits. */
export async function flushTraces(): Promise<void> {
  if (client) await client.awaitPendingTraceBatches();
}
