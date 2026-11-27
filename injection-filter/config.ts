import path from "node:path";

// Settings for the prompt-injection classifier. Not user-adjustable: the user
// decides what to do with flagged sentences, not whether they are checked.

/** Where scripts/classifier/export-onnx.sh puts the model. */
export const MODEL_ROOT = path.join(process.cwd(), "models");
export const MODEL_NAME = "injection-classifier";

/**
 * A sentence is flagged when P(injected) is at least this. It is the threshold
 * the v2 training run chose on its dev set (filter_config.json, 0.08495): the
 * lowest that keeps false alarms at or under 5% on documentation prose and 2% on
 * payment-like clean text. The model's scores are temperature-scaled, so a low
 * value is expected. See docs/Injection_Classifier.md for the sweep.
 * If the model is replaced, set this from the new filter_config.json and re-run the sweep.
 */
export const INJECTION_THRESHOLD = 0.0849;

/** Token limit the model was trained with. */
export const MAX_TOKENS = 256;
/** Long sentences are scored in overlapping word windows of this size, so nothing hides past the token limit. */
export const WINDOW_WORDS = 120;
export const WINDOW_OVERLAP_WORDS = 40;
/** Sentences per model call. */
export const BATCH_SIZE = 16;

/** Most flagged sentences shown on the review card (highest scores first). */
export const MAX_SHOWN_FLAGGED = 20;
/** Longest sentence text shown on the card. */
export const MAX_SHOWN_CHARS = 400;
