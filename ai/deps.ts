import type { Manifest } from "./manifest";
import type { ActivityPort, ContentGuardPort, ModelPort, TextEncoderPort } from "./ports";
import type { RawTools } from "./subagents/tools";

/** Everything the AI layer needs from outside. Tests replace any of these with stubs. */
export type AiDeps = {
  model: ModelPort;
  encoder: TextEncoderPort;
  manifest: Manifest;
  /** Raw fetch and PDF tools. Defaults to the real, network-guarded ones. */
  rawTools?: RawTools;
  /** Where progress lines go. */
  activity?: ActivityPort;
  /**
   * Injection check for web and PDF text, run before encoding. The pipeline
   * always supplies one (pipeline/content-guard.ts); tests may leave it out.
   */
  contentGuard?: ContentGuardPort;
};
