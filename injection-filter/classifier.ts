import { existsSync } from "node:fs";
import path from "node:path";
import { BATCH_SIZE, MAX_TOKENS, MODEL_NAME, MODEL_ROOT } from "./config";

// Runs the fine-tuned DeBERTa injection classifier in this process with
// onnxruntime (through @huggingface/transformers). Local files only: it never
// downloads anything, and the text it scores never leaves the machine.

type Tokenizer = {
  (texts: string[], options: { padding: boolean; truncation: boolean; max_length: number }): Record<string, unknown>;
  encode(text: string): number[];
};
type Model = (inputs: Record<string, unknown>) => Promise<{ logits: { data: ArrayLike<number>; dims: number[] } }>;
type Loaded = { tokenizer: Tokenizer; model: Model };

export class ClassifierUnavailableError extends Error {}

const MODEL_FILE = path.join(MODEL_ROOT, MODEL_NAME, "onnx", "model.onnx");

const globalForClassifier = globalThis as unknown as { __injectionClassifier?: Promise<Loaded> };

async function load(): Promise<Loaded> {
  if (!existsSync(MODEL_FILE)) {
    throw new ClassifierUnavailableError(
      "The injection classifier is not installed (models/injection-classifier). Run scripts/classifier/export-onnx.sh.",
    );
  }
  const { env, AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_ROOT + path.sep;
  try {
    const tokenizer = (await AutoTokenizer.from_pretrained(MODEL_NAME)) as unknown as Tokenizer;
    // Full precision only: the 8-bit version changes too many decisions (docs/Injection_Classifier.md).
    const model = (await AutoModelForSequenceClassification.from_pretrained(MODEL_NAME, { dtype: "fp32", device: "cpu" })) as unknown as Model;
    return { tokenizer, model };
  } catch (error) {
    throw new ClassifierUnavailableError(`The injection classifier could not be loaded: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

/** Loads the model once per server process; a failed load is retried on the next call. */
function loaded(): Promise<Loaded> {
  globalForClassifier.__injectionClassifier ??= load().catch((error) => {
    globalForClassifier.__injectionClassifier = undefined;
    throw error;
  });
  return globalForClassifier.__injectionClassifier;
}

/** Overlapping word windows that each fit the model's token limit. */
function windows(text: string, tokenizer: Tokenizer): string[] {
  const tokens = tokenizer.encode(text).length;
  if (tokens <= MAX_TOKENS) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  // Size windows from this sentence's own words-per-token ratio, with a margin.
  const size = Math.max(8, Math.floor((words.length * (MAX_TOKENS - 2) * 0.85) / tokens));
  const step = Math.max(1, Math.floor((size * 2) / 3));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += step) {
    out.push(words.slice(i, i + size).join(" "));
    if (i + size >= words.length) break;
  }
  return out;
}

function probabilities(logits: { data: ArrayLike<number>; dims: number[] }): number[] {
  const [rows, labels] = logits.dims;
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    const clean = Number(logits.data[r * labels]);
    const injected = Number(logits.data[r * labels + 1]);
    const max = Math.max(clean, injected);
    const a = Math.exp(clean - max);
    const b = Math.exp(injected - max);
    out.push(b / (a + b));
  }
  return out;
}

/**
 * P(injected) for each text. A text longer than the token limit is scored in
 * overlapping windows and gets its highest window score.
 */
export async function scoreSentences(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  const { tokenizer, model } = await loaded();

  const pieces: { owner: number; text: string }[] = [];
  texts.forEach((text, owner) => {
    for (const piece of windows(text, tokenizer)) pieces.push({ owner, text: piece });
  });
  // Similar lengths together: less padding, faster batches.
  const order = pieces.map((_, i) => i).sort((a, b) => pieces[a].text.length - pieces[b].text.length);

  const scores = new Array<number>(texts.length).fill(0);
  for (let i = 0; i < order.length; i += BATCH_SIZE) {
    const batch = order.slice(i, i + BATCH_SIZE);
    const inputs = tokenizer(batch.map((index) => pieces[index].text), { padding: true, truncation: true, max_length: MAX_TOKENS });
    const { logits } = await model(inputs);
    probabilities(logits).forEach((p, j) => {
      const owner = pieces[batch[j]].owner;
      scores[owner] = Math.max(scores[owner], p);
    });
  }
  return scores;
}
