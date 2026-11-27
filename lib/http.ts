import { z } from "zod";

export function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Rejects browser requests that come from another site. The app has no login,
 * so without this any web page open in the user's browser could call the API.
 */
export function crossOriginError(request: Request): Response | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null; // not a cross-site browser request
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return jsonError(403, "Forbidden");
  }
  return originHost === request.headers.get("host") ? null : jsonError(403, "Forbidden");
}

/** Checks the origin and validates the JSON body. Returns the parsed data or an error response. */
export async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ data: z.infer<S> } | { error: Response }> {
  const blocked = crossOriginError(request);
  if (blocked) return { error: blocked };
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: jsonError(400, "Invalid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { error: jsonError(400, parsed.error.issues[0]?.message ?? "Invalid request") };
  }
  return { data: parsed.data };
}

export const sessionIdSchema = z.uuid();

export function parseId(value: string): number | null {
  return /^[1-9]\d{0,14}$/.test(value) ? Number(value) : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_UNIQUE";
}
