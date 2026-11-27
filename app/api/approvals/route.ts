import { listPending } from "@/approvals/registry";
import { jsonError, sessionIdSchema } from "@/lib/http";

// Lets a reloaded page restore approval cards that are still open.
export async function GET(request: Request) {
  const session = sessionIdSchema.safeParse(new URL(request.url).searchParams.get("session"));
  if (!session.success) return jsonError(400, "Invalid session");
  return Response.json(listPending(session.data));
}
