import { filterRulesEmitter } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/filter-rules/stream - SSE: pushes { type: "filter_rules_updated" }
// whenever a rule is created/updated/deleted/reordered. Lets dashboard tabs
// auto-refresh.
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, send: null };

  const stream = new ReadableStream({
    async start(controller) {
      state.send = () => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "filter_rules_updated" })}\n\n`));
        } catch {
          state.closed = true;
          filterRulesEmitter.off("update", state.send);
          clearInterval(state.keepalive);
        }
      };

      // Initial hello so client knows the stream is alive.
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "filter_rules_ready" })}\n\n`));
      } catch { /* ignore */ }

      filterRulesEmitter.on("update", state.send);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },
    cancel() {
      state.closed = true;
      filterRulesEmitter.off("update", state.send);
      clearInterval(state.keepalive);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
