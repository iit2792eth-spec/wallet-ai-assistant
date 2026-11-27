import { z } from "zod";
import manifestJson from "./function_manifest.json";

const functionSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)?$/),
  kind: z.enum(["read", "propose", "ui", "util"]),
  params: z.array(z.strictObject({ name: z.string(), type: z.string() })),
  returns: z.string(),
  description: z.string(),
});

const manifestSchema = z.strictObject({
  version: z.number().int(),
  functions: z.array(functionSchema),
  actions: z.array(
    z.strictObject({ action: z.string(), fields: z.record(z.string(), z.string()), description: z.string() }),
  ),
  types: z.record(z.string(), z.string()),
});

export type ManifestData = z.infer<typeof manifestSchema>;

/**
 * The functions the access layer injects into the sandbox. This is the Coder's
 * reference and the Code Verifier's call allowlist.
 */
export class Manifest {
  readonly data: ManifestData;
  /** Functions called by bare name, e.g. "propose". */
  readonly plainFunctions: ReadonlySet<string>;
  /** Namespace objects whose members are functions, e.g. "wallet". */
  readonly namespaces: ReadonlySet<string>;
  readonly functionNames: ReadonlySet<string>;
  readonly actionNames: ReadonlySet<string>;

  constructor(raw: unknown) {
    this.data = manifestSchema.parse(raw);
    const names = this.data.functions.map((fn) => fn.name);
    this.functionNames = new Set(names);
    this.plainFunctions = new Set(names.filter((name) => !name.includes(".")));
    this.namespaces = new Set(names.filter((name) => name.includes(".")).map((name) => name.split(".")[0]));
    this.actionNames = new Set(this.data.actions.map((action) => action.action));
  }

  /** Text inserted into prompts. */
  describe(): string {
    return JSON.stringify(this.data, null, 2);
  }
}

let loaded: Manifest | undefined;

/** The manifest shipped with the app, validated on first use. */
export function loadManifest(): Manifest {
  return (loaded ??= new Manifest(manifestJson));
}
