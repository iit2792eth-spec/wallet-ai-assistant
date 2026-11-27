import { runPlan } from "@/access";
import { runAiLayer } from "@/ai";
import { addRecord, clearAiSession, getAiSession } from "@/ai/session";
import { loadManifest } from "@/ai/manifest";
import { createModel, resolvedBaseUrl } from "@/ai/model/factory";
import { httpsOnlyRefusal } from "@/lib/https-only";
import { getActiveModelConfig } from "@/db/models";
import { publish } from "@/events/bus";
import { audit, redact } from "@/lib/logger";
import { Activity } from "@/lib/activity";
import { pasteReasons } from "@/lib/pasted";
import { ContentBlockedError } from "@/ai/ports";
import { createContentGuard } from "./content-guard";
import { decodeCodeResult, decodeTables } from "@/text-decoder";
import { planRecord } from "./record";
import { setAsideNotices } from "./set-aside";
import { clearVault, getVault, hasStaleVault } from "@/text-encoder";

// Carries one chat message through the pipeline:
// Text Encoder -> AI layer -> Text Decoder -> Access Layer (-> Wallet Layer).
// Everything the user sees comes back over the event stream.

const globalForBusy = globalThis as unknown as { __busySessions?: Set<string> };
const busy = (globalForBusy.__busySessions ??= new Set());

export const isBusy = (sessionId: string) => busy.has(sessionId);

export async function handleMessage(sessionId: string, text: string, options: { pasted?: boolean } = {}): Promise<void> {
  if (busy.has(sessionId)) return;
  busy.add(sessionId);
  publish(sessionId, { type: "busy", busy: true });
  // The live activity stream for this message, shared by every layer.
  const activity = new Activity(sessionId);

  try {
    const config = getActiveModelConfig();
    if (!config) {
      publish(sessionId, { type: "status", level: "error", text: "No model selected. Add one in Settings." });
      return;
    }

    // HTTPS only (Settings): refuse a model endpoint that is not https before anything is sent to it.
    const modelRefusal = httpsOnlyRefusal(resolvedBaseUrl(config), `The model "${config.label}" (${resolvedBaseUrl(config)})`);
    if (modelRefusal) {
      audit("https_only_refused", { session: sessionId, what: "model", provider: config.provider });
      publish(sessionId, { type: "status", level: "error", text: `Request refused: ${modelRefusal}` });
      return;
    }

    // After a code reload in development, start the session afresh rather than run an old encoder.
    // The conversation goes too: its placeholders belonged to the old mapping.
    if (hasStaleVault(sessionId)) {
      clearVault(sessionId);
      clearAiSession(sessionId);
    }
    const encoder = getVault(sessionId);
    const started = Date.now();
    // Pasted text is decided in code. Its addresses are recorded as pasted, never as typed by the user.
    const pasted = pasteReasons(text, { clipboard: options.pasted });
    // Someone else's text (pasted messages here, web pages and PDFs in the AI layer) is checked
    // for injected instructions before any model sees it. Typed messages are not checked.
    const guard = createContentGuard({ sessionId, activity });
    let message = text;
    if (pasted.length > 0) {
      activity.info("Treating your message as pasted text: its addresses count as not typed by you");
      try {
        message = await guard.check(text, { kind: "pasted" });
      } catch (error) {
        if (!(error instanceof ContentBlockedError)) throw error;
        publish(sessionId, { type: "status", level: "error", text: error.message });
        return;
      }
    }
    const { result, revisions, reviewNotes, mode, external, externalTables, setAside } = await runAiLayer(
      { model: createModel(config), encoder, manifest: loadManifest(), activity, contentGuard: guard },
      sessionId,
      encoder.encode(message, { kind: pasted.length > 0 ? "pasted" : "user" }),
      { pasted: pasted.length > 0 },
    );
    // The user's own values are put back only in text shown to the user.
    const display = (value: string) => encoder.displayDecode(value);

    audit("ai_result", {
      session: sessionId,
      type: result.type,
      ms: Date.now() - started,
      revisions,
      reviewNotes,
      ...(result.type === "code" ? { mode, external } : {}),
      ...(pasted.length > 0 ? { pasted } : {}),
      ...(result.type === "code"
        ? { code: result.code, functionsUsed: result.functions_used, externalFields: result.external_fields }
        : result.type === "rejection"
          ? { reason: result.reason }
          : { missing: result.missing }),
    });

    if (result.type === "clarification") {
      publish(sessionId, { type: "message", text: display(result.question) });
    } else if (result.type === "rejection") {
      publish(sessionId, { type: "status", level: "error", text: display(result.message) });
    } else {
      // The Text Decoder validates the code and restores placeholders from the mapping.
      const restoring = activity.start("Restoring your addresses into the program");
      const restore = (placeholder: string) => encoder.restore(placeholder);
      const decoded = decodeCodeResult(result, restore);
      // Document tables the program reads with external.rows() are restored the same way, all or nothing.
      const tables = decoded.type === "rejection" ? [] : decodeTables(externalTables, restore);
      const refusal = decoded.type === "rejection" ? decoded : !Array.isArray(tables) ? tables : null;
      if (refusal) activity.fail(restoring, refusal.message);
      else activity.done(restoring);
      if (refusal || decoded.type === "rejection" || !Array.isArray(tables)) {
        publish(sessionId, { type: "status", level: "error", text: refusal?.message ?? "The request could not be processed." });
        addRecord(getAiSession(sessionId), "(The plan was refused by the safety checks; nothing was sent or signed.)");
        return;
      }
      publish(sessionId, {
        type: "code_result",
        summary: display(decoded.summary),
        mode,
        externalFields: decoded.external_fields,
      });
      for (const note of reviewNotes) {
        publish(sessionId, { type: "status", level: "info", text: `Reviewer note (unverified): ${display(note)}` });
      }
      // The access layer checks and runs the program. Its results never return to the AI layer:
      // the AI session only learns a one-word outcome.
      // The record of what happened is written from the access layer's report, never by a model.
      let record = "(The request failed; nothing was sent or signed.)";
      await runPlan({
        sessionId,
        decoded,
        mode,
        external,
        pasted: pasted.length > 0,
        injectionNotices: guard.notices,
        setAsideNotices: setAsideNotices(setAside, display),
        // Typed messages of this request only (pasted ones never count): where a swap slippage figure may come from.
        userTyped: (() => {
          const session = getAiSession(sessionId);
          return session.turns.filter((t) => t.request === session.request && t.role === "user" && t.kind === "typed").map((t) => t.text);
        })(),
        tables,
        activity,
        report: (report) => {
          record = planRecord(report, (value) => encoder.placeholderOf(value));
        },
      });
      addRecord(getAiSession(sessionId), record);
    }
  } catch (error) {
    // First line only: provider errors can run to several lines of detail.
    const message = redact(error instanceof Error ? error.message : "unknown error").split("\n")[0].slice(0, 200);
    audit("ai_error", { session: sessionId, message });
    publish(sessionId, { type: "status", level: "error", text: `The request failed: ${message}` });
  } finally {
    activity.end();
    busy.delete(sessionId);
    publish(sessionId, { type: "busy", busy: false });
  }
}
