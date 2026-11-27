import path from "node:path";
import type { AiDeps } from "../deps";
import { audit, redact } from "@/lib/logger";
import { MAX_EXTERNAL_TEXT_CHARS } from "../config";
import { ModelOutputError } from "../model/call-json";
import { NetworkPolicyError } from "../net/guarded-fetch";
import { ContentBlockedError } from "../ports";
import type { ExternalField, ExternalTable, SetAsideLine } from "../schemas";
import type { State, StateUpdate } from "../state";
import { IncompleteExtractionError, TooManyRowsError, extractFields } from "../subagents/extract";
import { defaultRawTools, encodedTools } from "../subagents/tools";

const isUrl = (location: string) => /^https?:\/\//i.test(location);

/**
 * Runs the Web Scraping and PDF Reader subagents for the sources named in the
 * plan. Each subagent has only its own tool, and which URL or file it opens is
 * decided here from the plan, not by a model.
 */
export function executorNode(deps: AiDeps) {
  return async (state: State): Promise<StateUpdate> => {
    const tools = encodedTools(deps.rawTools ?? defaultRawTools, deps.encoder, deps.contentGuard);
    const externalFields: ExternalField[] = [];
    const externalTables: ExternalTable[] = [];
    const setAside: SetAsideLine[] = [];
    let stage: "read" | "extract" = "read";

    try {
      for (const item of state.plan?.external_data ?? []) {
        // A PDF given as a URL is downloaded by the scraper; the PDF reader only opens local files.
        const useWeb = item.kind === "web" || isUrl(item.location);
        if (useWeb && !isUrl(item.location)) throw new Error("A web page must be given as an http or https URL");

        const name = useWeb ? item.location : path.basename(item.location);
        const line = deps.activity?.start(`Reading ${item.kind === "pdf" ? "the PDF" : "the web page"} ${name}`);
        let encodedContent: string;
        stage = "read";
        try {
          encodedContent = useWeb ? await tools.web.fetchPage(item.location) : await tools.pdf.readPdf(item.location);
        } catch (error) {
          if (line) {
            if (error instanceof ContentBlockedError) deps.activity?.fail(line);
            else deps.activity?.fail(line, error instanceof Error ? error.message : undefined);
          }
          throw error;
        }
        if (line) deps.activity?.done(line);
        const source = useWeb
          ? ({ kind: "web", ref: item.location } as const)
          : ({ kind: "pdf", ref: path.basename(item.location) } as const);

        if (encodedContent.length >= MAX_EXTERNAL_TEXT_CHARS) {
          deps.activity?.info(`Only the first ${MAX_EXTERNAL_TEXT_CHARS.toLocaleString("en-US")} characters of ${name} were read`, { level: "detail" });
        }

        stage = "extract";
        const extracting = deps.activity?.start(`Reading the payments and details in ${name}`, { level: "detail" });
        let extracted;
        try {
          extracted = await extractFields({ model: deps.model, encoder: deps.encoder, purpose: item.purpose, source, encodedContent });
        } catch (error) {
          if (extracting) {
            deps.activity?.fail(extracting, error instanceof TooManyRowsError ? "Too many rows" : error instanceof IncompleteExtractionError ? "Some lines could not be read reliably" : undefined);
          }
          throw error;
        }
        const rows = extracted.tables.reduce((sum, t) => sum + t.rows.length, 0);
        // The accounting is stated so the user can compare it with the document.
        const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
        if (extracting) {
          deps.activity?.done(
            extracting,
            extracted.candidates
              ? `${plural(extracted.candidates, "line")} could hold a payment: ${plural(rows, "payment")} read${extracted.setAside.length ? `, ${extracted.setAside.length} set aside` : ""}`
              : undefined,
          );
        }
        // The accounting goes to the audit log too: segment numbers and reasons only, no document text.
        audit("ai_document_extracted", {
          source: source.kind,
          candidates: extracted.candidates,
          payments: rows,
          setAside: extracted.setAside.map((s) => `${s.segment}:${s.reason}`),
        });
        if (extracted.setAside.length) {
          const reasons = new Map<string, number[]>();
          for (const s of extracted.setAside) reasons.set(s.reason, [...(reasons.get(s.reason) ?? []), s.segment]);
          const label: Record<string, string> = {
            header: "headers", sender_only: "sender only", total: "totals", information: "no payment",
            instruction_to_ignore: "instructions ignored", other: "other",
          };
          deps.activity?.info(
            `Set aside in ${name}: ${[...reasons].map(([reason, segs]) => `${label[reason] ?? reason} (line${segs.length === 1 ? "" : "s"} ${segs.slice(0, 8).join(", ")}${segs.length > 8 ? ", …" : ""})`).join("; ")}`,
            { level: "detail" },
          );
        }
        externalFields.push(...extracted.fields);
        externalTables.push(...extracted.tables);
        setAside.push(...extracted.setAside.map((s) => ({ source: source.ref, ...s })));
      }
    } catch (error) {
      // The user cancelled after the injection check, or the check could not run: say so plainly.
      if (error instanceof ContentBlockedError) {
        return { result: { type: "rejection", reason: "other", message: error.message } };
      }
      if (error instanceof TooManyRowsError || error instanceof IncompleteExtractionError) {
        audit("ai_document_failed", { stage, kind: error instanceof TooManyRowsError ? "too_many_rows" : "incomplete_extraction", message: redact(error.message).slice(0, 300) });
        return { result: { type: "rejection", reason: "other", message: error.message } };
      }
      // The real cause always goes to the audit log; the user gets the part that is safe and useful.
      audit("ai_document_failed", {
        stage,
        kind: error instanceof NetworkPolicyError ? "network_policy" : error instanceof ModelOutputError ? "model_output" : error instanceof Error ? error.name : "unknown",
        message: redact(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
      const detail =
        error instanceof NetworkPolicyError
          ? error.message
          : stage === "extract"
            ? error instanceof ModelOutputError
              ? "The model could not turn it into data in the expected form, even after retrying."
              : "The details could not be extracted from it."
            : "The document could not be read.";
      return { result: { type: "rejection", reason: "other", message: `I could not use that document. ${detail}` } };
    }
    return { externalFields, externalTables, setAside };
  };
}

export const routeAfterExecutor = (state: State): "coder" | "__end__" => (state.result ? "__end__" : "coder");
