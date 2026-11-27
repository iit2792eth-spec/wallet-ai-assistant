export const PROVIDERS = ["openai_compatible", "ollama", "anthropic", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
  openai_compatible: "OpenAI / compatible",
  ollama: "Ollama",
  anthropic: "Anthropic",
  google: "Google",
};

/** Used when a model has no base URL. Only custom or local endpoints need one. */
export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  openai_compatible: "https://api.openai.com/v1",
  ollama: "http://localhost:11434",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
};

/** Safe to send to the browser: the API key itself is never included. */
export type ModelSummary = {
  id: number;
  label: string;
  provider: Provider;
  modelName: string;
  baseUrl: string | null;
  hasApiKey: boolean;
};
