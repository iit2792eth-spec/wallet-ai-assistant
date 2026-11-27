import { after } from "next/server";
import { z } from "zod";
import { jsonError, readBody, sessionIdSchema } from "@/lib/http";
import { handleMessage, isBusy } from "@/pipeline/handle-message";

const bodySchema = z.object({
  sessionId: sessionIdSchema,
  text: z.string().trim().min(1).max(8000),
  /** The browser saw some of the text pasted or dropped in. Can only make the request more cautious. */
  pasted: z.boolean().optional().default(false),
});

// Accepts a chat message and returns at once. The reply arrives over the event stream.
export async function POST(request: Request) {
  const body = await readBody(request, bodySchema);
  if ("error" in body) return body.error;
  const { sessionId, text, pasted } = body.data;
  if (isBusy(sessionId)) return jsonError(409, "Still working on your previous message");

  after(() => handleMessage(sessionId, text, { pasted }));
  return Response.json({ ok: true }, { status: 202 });
}
