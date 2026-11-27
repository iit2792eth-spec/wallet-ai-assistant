import { getDb } from "./index";
import { getSetting } from "./settings";
import type { ModelSummary, Provider } from "@/lib/model-types";

export type ModelInput = {
  label: string;
  provider: Provider;
  modelName: string;
  baseUrl: string | null;
  apiKey: string | null;
};

type Row = Omit<ModelSummary, "hasApiKey"> & { hasApiKey: number };

export function listModels(): ModelSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, label, provider, model_name AS modelName, base_url AS baseUrl,
              (api_key IS NOT NULL AND api_key <> '') AS hasApiKey
       FROM model_configs ORDER BY id`,
    )
    .all() as Row[];
  return rows.map((row) => ({ ...row, hasApiKey: row.hasApiKey === 1 }));
}

export function modelExists(id: number): boolean {
  return getDb().prepare("SELECT 1 FROM model_configs WHERE id = ?").get(id) !== undefined;
}

export function createModel(input: ModelInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO model_configs (label, provider, model_name, base_url, api_key)
       VALUES (@label, @provider, @modelName, @baseUrl, @apiKey)`,
    )
    .run(input);
  return Number(result.lastInsertRowid);
}

export type ModelUpdate = ModelInput & { clearApiKey: boolean };

/**
 * Updates a model. A missing API key keeps the saved one, except when the provider or base URL
 * changes: a saved key is never sent to a different endpoint than the one it was entered for.
 * Returns false when the model does not exist.
 */
export function updateModel(id: number, update: ModelUpdate): boolean {
  const db = getDb();
  const current = db
    .prepare("SELECT provider, base_url AS baseUrl, api_key AS apiKey FROM model_configs WHERE id = ?")
    .get(id) as Pick<ModelInput, "provider" | "baseUrl" | "apiKey"> | undefined;
  if (!current) return false;
  const endpointChanged = current.provider !== update.provider || current.baseUrl !== update.baseUrl;
  const apiKey = update.apiKey ?? (update.clearApiKey || endpointChanged ? null : current.apiKey);
  db.prepare(
    `UPDATE model_configs
     SET label = @label, provider = @provider, model_name = @modelName, base_url = @baseUrl, api_key = @apiKey
     WHERE id = @id`,
  ).run({ id, label: update.label, provider: update.provider, modelName: update.modelName, baseUrl: update.baseUrl, apiKey });
  return true;
}

export function deleteModel(id: number): boolean {
  return getDb().prepare("DELETE FROM model_configs WHERE id = ?").run(id).changes > 0;
}

/** The selected model with its API key. Server-side only: never send this to the browser. */
export function getActiveModelConfig(): ModelInput | undefined {
  const id = Number(getSetting("active_model_id"));
  if (!(id > 0)) return undefined;
  return getDb()
    .prepare(
      `SELECT label, provider, model_name AS modelName, base_url AS baseUrl, api_key AS apiKey
       FROM model_configs WHERE id = ?`,
    )
    .get(id) as ModelInput | undefined;
}
