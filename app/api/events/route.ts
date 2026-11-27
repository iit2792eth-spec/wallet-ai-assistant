import { subscribe } from "@/events/bus";
import type { ServerEvent } from "@/events/types";
import { jsonError, sessionIdSchema } from "@/lib/http";
import { sessionConnected, sessionDisconnected } from "@/pipeline/session-lifecycle";

const KEEP_ALIVE_MS = 25_000;

// Server-sent events: one long-lived response per browser tab.
export async function GET(request: Request) {
  const session = sessionIdSchema.safeParse(new URL(request.url).searchParams.get("session"));
  if (!session.success) return jsonError(400, "Invalid session");

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup(); // stream already closed
        }
      };
      const unsubscribe = subscribe(session.data, (event: ServerEvent) =>
        write(`data: ${JSON.stringify(event)}\n\n`),
      );
      const keepAlive = setInterval(() => write(": keep-alive\n\n"), KEEP_ALIVE_MS);
      sessionConnected(session.data);
      let closed = false;
      cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(keepAlive);
        sessionDisconnected(session.data);
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      write(": connected\n\n");
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
