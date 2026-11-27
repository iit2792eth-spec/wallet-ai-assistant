import { describe, expect, it } from "vitest";
import { initModel, providerHost, type ModelConfig } from "@/ai/model/factory";

const config = (over: Partial<ModelConfig>): ModelConfig => ({
  provider: "openai_compatible",
  modelName: "gpt-5.4",
  baseUrl: null,
  apiKey: "sk-test",
  ...over,
});

/** The provider class instance behind initChatModel's wrapper. */
async function inner(c: ModelConfig) {
  const wrapper = (await initModel(c)) as unknown as { _getModelInstance(): Promise<Record<string, unknown>> };
  return wrapper._getModelInstance();
}

describe("model factory", () => {
  it("uses each provider's standard host when no base URL is set", () => {
    expect(providerHost(config({}))).toBe("api.openai.com");
    expect(providerHost(config({ provider: "anthropic" }))).toBe("api.anthropic.com");
    expect(providerHost(config({ provider: "google" }))).toBe("generativelanguage.googleapis.com");
    expect(providerHost(config({ provider: "ollama" }))).toBe("localhost:11434");
  });

  it("uses the custom base URL's host when one is set", () => {
    expect(providerHost(config({ baseUrl: "http://127.0.0.1:1234/v1" }))).toBe("127.0.0.1:1234");
  });

  it("builds the right provider class through initChatModel", async () => {
    expect((await inner(config({}))).constructor.name).toBe("ChatOpenAI");
    expect((await inner(config({ provider: "anthropic", modelName: "claude-opus-5-5" }))).constructor.name).toBe("ChatAnthropic");
    expect((await inner(config({ provider: "ollama", modelName: "qwen3", apiKey: null }))).constructor.name).toBe("ChatOllama");
    expect((await inner(config({ provider: "google", modelName: "gemini-2.5-pro" }))).constructor.name).toBe("ChatGoogleGenerativeAI");
  });

  it("passes provider settings through", async () => {
    const ollama = await inner(config({ provider: "ollama", modelName: "qwen3", apiKey: null }));
    expect(ollama.baseUrl).toBe("http://localhost:11434");
    expect(ollama.format).toBe("json");
    const anthropic = await inner(config({ provider: "anthropic", modelName: "claude-opus-5-5" }));
    expect(anthropic.maxTokens).toBe(4096);
  });

  it("the client's fetch is locked to the provider host", async () => {
    const openai = (await inner(config({}))) as { clientConfig: { fetch: typeof fetch } };
    await expect(async () => openai.clientConfig.fetch("https://evil.example/v1/chat/completions")).rejects.toThrow(
      /only api\.openai\.com is allowed/,
    );
  });

  it("nothing can be reconfigured at call time (no swapping endpoint or key)", async () => {
    const chat = (await initModel(config({}))) as unknown as { _configurableFields: unknown };
    expect(chat._configurableFields).toEqual([]);
  });
});
