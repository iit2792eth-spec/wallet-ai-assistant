import { loadManifest } from "@/ai/manifest";
import { checkCode, checkFunctionsUsed } from "@/ai/verifier/ast-checks";
import type { DecodedResult } from "@/text-decoder";

/**
 * The Plan Validator: the Code Verifier's deterministic checks, run again on
 * the decoded program right before it runs. Same allowlist, forbidden
 * constructs, loop and amount rules; real addresses are expected now and any
 * leftover placeholder is an error. Returns the problems found (empty = valid).
 */
export function validatePlan(decoded: DecodedResult): string[] {
  const ast = checkCode(decoded.code, {
    manifest: loadManifest(),
    isKnownPlaceholder: () => false,
    stage: "decoded",
  });
  if (ast.errors.length > 0) return ast.errors;
  return checkFunctionsUsed(decoded.functions_used, ast.functionsCalled);
}
