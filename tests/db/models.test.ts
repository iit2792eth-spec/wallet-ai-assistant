import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Never touch data/app.db: every test gets a fresh in-memory database.
let db: Database.Database;
vi.mock("@/db/index", () => ({ getDb: () => db }));

const { createModel, updateModel, getActiveModelConfig } = await import("@/db/models");
const { modelSchema, modelUpdateSchema } = await import("@/lib/validation");

const schema = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");

function stored(id: number) {
  return db.prepare("SELECT label, provider, model_name, base_url, api_key FROM model_configs WHERE id = ?").get(id) as {
    label: string;
    provider: string;
    model_name: string;
    base_url: string | null;
    api_key: string | null;
  };
}

const base = { label: "GPT", provider: "openai_compatible" as const, modelName: "gpt-5.4", baseUrl: null, apiKey: "sk-1" };

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
});

describe("model validation", () => {
  it("accepts every provider without a base URL", () => {
    for (const provider of ["openai_compatible", "ollama", "anthropic", "google"]) {
      const parsed = modelSchema.safeParse({ label: "m", provider, modelName: "x", baseUrl: "", apiKey: "" });
      expect(parsed.success).toBe(true);
      expect(parsed.data?.baseUrl).toBeNull();
    }
  });

  it("still rejects a malformed base URL", () => {
    expect(modelSchema.safeParse({ label: "m", provider: "ollama", modelName: "x", baseUrl: "ftp://x", apiKey: "" }).success).toBe(false);
  });

  it("defaults clearApiKey to false on update", () => {
    const parsed = modelUpdateSchema.parse({ label: "m", provider: "anthropic", modelName: "x", baseUrl: "", apiKey: "" });
    expect(parsed.clearApiKey).toBe(false);
  });
});

describe("updateModel", () => {
  it("changes fields and keeps the saved key when none is given", () => {
    const id = createModel(base);
    expect(updateModel(id, { ...base, label: "GPT big", modelName: "gpt-5.5", apiKey: null, clearApiKey: false })).toBe(true);
    expect(stored(id)).toEqual({ label: "GPT big", provider: "openai_compatible", model_name: "gpt-5.5", base_url: null, api_key: "sk-1" });
  });

  it("replaces the key when a new one is given", () => {
    const id = createModel(base);
    updateModel(id, { ...base, apiKey: "sk-2", clearApiKey: false });
    expect(stored(id).api_key).toBe("sk-2");
  });

  it("removes the key when asked", () => {
    const id = createModel(base);
    updateModel(id, { ...base, apiKey: null, clearApiKey: true });
    expect(stored(id).api_key).toBeNull();
  });

  it("drops the saved key when the base URL changes, so it is never sent to another host", () => {
    const id = createModel(base);
    updateModel(id, { ...base, baseUrl: "https://elsewhere.example/v1", apiKey: null, clearApiKey: false });
    expect(stored(id).api_key).toBeNull();
  });

  it("drops the saved key when the provider changes", () => {
    const id = createModel(base);
    updateModel(id, { ...base, provider: "anthropic", apiKey: null, clearApiKey: false });
    expect(stored(id).api_key).toBeNull();
  });

  it("keeps a new key even when the endpoint changes", () => {
    const id = createModel(base);
    updateModel(id, { ...base, provider: "anthropic", apiKey: "sk-ant", clearApiKey: false });
    expect(stored(id).api_key).toBe("sk-ant");
  });

  it("returns false for a missing model", () => {
    expect(updateModel(999, { ...base, clearApiKey: false })).toBe(false);
  });

  it("enforces unique labels", () => {
    createModel(base);
    const id = createModel({ ...base, label: "Other" });
    expect(() => updateModel(id, { ...base, clearApiKey: false })).toThrow(/UNIQUE/);
  });

  it("the active model reflects an edit immediately", () => {
    const id = createModel(base);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'active_model_id'").run(String(id));
    updateModel(id, { ...base, modelName: "gpt-5.5", apiKey: null, clearApiKey: false });
    expect(getActiveModelConfig()?.modelName).toBe("gpt-5.5");
  });
});
