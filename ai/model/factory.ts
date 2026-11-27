import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { initChatModel } from "langchain/chat_models/universal";
import { DEFAULT_BASE_URLS, type Provider } from "@/lib/model-types";
import { hostLockedFetch } from "../net/host-locked-fetch";
import type { ModelPort } from "../ports";

export type ModelConfig = {
  provider: Provider;
  modelName: string;
  /** Optional: each provider falls back to its standard endpoint (DEFAULT_BASE_URLS). */
  baseUrl: string | null;
  apiKey: string | null;
};

/** initChatModel's name for each provider we offer. */
const LANGCHAIN_PROVIDER: Record<Provider, string> = {
  openai_compatible: "openai",
  ollama: "ollama",
  anthropic: "anthropic",
  google: "google-genai",
};

export function resolvedBaseUrl(config: ModelConfig): string {
  return config.baseUrl ?? DEFAULT_BASE_URLS[config.provider];
}

/** The one host this model's client is allowed to contact. */
export function providerHost(config: ModelConfig): string {
  return new URL(resolvedBaseUrl(config)).host;
}

/** Provider-specific constructor fields; initChatModel passes them through to the provider class. */
function providerFields(config: ModelConfig): Record<string, unknown> {
  const fetch = hostLockedFetch(providerHost(config));
  const baseUrl = resolvedBaseUrl(config);
  const apiKey = config.apiKey ?? undefined;

  switch (config.provider) {
    case "ollama":
      // format "json" constrains decoding to valid JSON.
      return { baseUrl, temperature: 0, format: "json", fetch };
    case "openai_compatible":
      return {
        temperature: 0,
        // Local OpenAI-compatible servers often need no key, but the client requires one.
        apiKey: apiKey ?? (config.baseUrl ? "not-needed" : undefined),
        configuration: { baseURL: baseUrl, fetch },
      };
    case "anthropic":
      return { apiKey, maxTokens: 4096, anthropicApiUrl: baseUrl, clientOptions: { fetch } };
    case "google":
      // This client offers no way to supply a fetch, so the host lock does not apply to it.
      return { apiKey, temperature: 0, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) };
  }
}

export function initModel(config: ModelConfig): Promise<BaseChatModel> {
  return initChatModel(config.modelName, {
    modelProvider: LANGCHAIN_PROVIDER[config.provider],
    // Nothing may be changed at call time (no swapping the endpoint or key through run config).
    configurableFields: [],
    ...providerFields(config),
  });
}

/** Builds the model the user selected. Works the same for local and online providers. */
export function createModel(config: ModelConfig): ModelPort {
  let chat: Promise<BaseChatModel> | undefined;
  return {
    async invoke(task, messages) {
      chat ??= initModel(config);
      const reply = await (await chat).invoke(
        messages.map(({ role, content }) => ({ role, content })),
        { runName: task, metadata: { task, provider: config.provider, model: config.modelName } },
      );
      const { content } = reply;
      if (typeof content === "string") return content;
      return content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
    },
  };
}
