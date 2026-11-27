import { z } from "zod";
import { resolveApproval } from "@/approvals/registry";
import { jsonError, readBody, sessionIdSchema } from "@/lib/http";

const bodySchema = z.object({
  sessionId: sessionIdSchema,
  decision: z.enum(["approved", "rejected", "keep"]),
  /** Plan cards only: the step indexes left ticked. Omitted = every step on the card. */
  selected: z.array(z.number().int().min(0)).max(1_000).optional(),
});

export async function POST(request: Request, ctx: RouteContext<"/api/approvals/[id]">) {
  const body = await readBody(request, bodySchema);
  if ("error" in body) return body.error;
  const { id } = await ctx.params;
  if (!resolveApproval(id, body.data.sessionId, body.data.decision, body.data.selected)) {
    return jsonError(409, "This request is no longer pending");
  }
  return Response.json({ ok: true });
}
