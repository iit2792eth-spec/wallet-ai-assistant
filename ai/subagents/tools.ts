import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { convert } from "html-to-text";
import { MAX_EXTERNAL_TEXT_CHARS, MAX_PAGE_BYTES, MAX_PDF_BYTES, PDF_TIMEOUT_MS } from "../config";
import { guardedFetch } from "../net/guarded-fetch";
import type { ContentGuardPort, ContentSource, TextEncoderPort } from "../ports";

const run = promisify(execFile);

/** Tools that return raw, unencoded text. Never handed to a subagent directly. */
export interface RawTools {
  fetchWebText(url: string): Promise<string>;
  extractPdfText(filePath: string): Promise<string>;
}

/** The only tools a subagent gets. Their output is already encoded. */
export type SubagentTools = {
  web: { fetchPage(url: string): Promise<string> };
  pdf: { readPdf(filePath: string): Promise<string> };
};

const WORKER = path.join(process.cwd(), "ai", "subagents", "pdf-worker.mjs");
const DATA_DIR = path.join(process.cwd(), "data");

/**
 * Extracts PDF text in a separate Node process started with the permission
 * model: it can read the PDF and its own code, and has no network, no writes
 * and no child processes.
 */
async function extractPdfText(filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== ".pdf") {
    throw new Error("Give the full path of a .pdf file");
  }
  const real = await realpath(filePath);
  // The app's own files (database, keystore, logs) are never readable as a document.
  if (real === DATA_DIR || real.startsWith(DATA_DIR + path.sep)) throw new Error("That file cannot be read");
  if ((await stat(real)).size > MAX_PDF_BYTES) throw new Error("The PDF is too large");

  const { stdout } = await run(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${real}`,
      `--allow-fs-read=${WORKER}`,
      `--allow-fs-read=${path.join(process.cwd(), "node_modules")}`,
      WORKER,
      real,
    ],
    { timeout: PDF_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", env: { NODE_ENV: "production" } },
  );
  return stdout;
}

async function fetchWebText(url: string): Promise<string> {
  const document = await guardedFetch(url, Math.max(MAX_PAGE_BYTES, MAX_PDF_BYTES));
  const isPdf = document.contentType.includes("application/pdf") || document.body.subarray(0, 5).toString() === "%PDF-";

  if (isPdf) {
    // The PDF Reader never uses the network: the scraper downloads, the reader opens the local copy.
    const dir = await mkdtemp(path.join(tmpdir(), "fetched-pdf-"));
    const file = path.join(dir, "document.pdf");
    try {
      await writeFile(file, document.body);
      return await extractPdfText(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (document.body.byteLength > MAX_PAGE_BYTES) throw new Error("The page is too large");
  const text = document.body.toString("utf8");
  if (!document.contentType.includes("html")) return text;
  const options = {
    wordwrap: false as const,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  };
  // The <title> is in <head>, which the conversion drops; many pages put their name only there.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1];
  const titleText = title ? convert(title, options).trim() : "";
  const body = convert(text, options);
  return titleText ? `Page title: ${titleText}\n\n${body}` : body;
}

export const defaultRawTools: RawTools = { fetchWebText, extractPdfText };

const WRAPPED_HEX = /0x[0-9a-fA-F]+(?:[ \t]*\r?\n[ \t]*[0-9a-fA-F]+)+/g;
const FULL_LENGTHS = new Set([40, 64]);

/**
 * Rejoins an address (or key) that a document wrapped across lines, as narrow
 * table columns in PDFs do: "0xc0F8…43C\n1f3460e" becomes one value. Pieces are
 * joined only while the result is shorter than 64 hex characters, and only if
 * they add up to exactly 40 or 64, so unrelated lines are never merged.
 */
export function rejoinWrappedHex(text: string): string {
  return text.replace(WRAPPED_HEX, (match) => {
    const pieces = match.split(/[ \t]*\r?\n[ \t]*/);
    let hex = pieces[0].slice(2);
    for (let i = 1; i <= pieces.length; i++) {
      if (FULL_LENGTHS.has(hex.length) && (i === pieces.length || hex.length === 64 || !FULL_LENGTHS.has(hex.length + pieces[i].length))) {
        return `0x${hex}${i < pieces.length ? `\n${pieces.slice(i).join("\n")}` : ""}`;
      }
      if (i === pieces.length || hex.length + pieces[i].length > 64) break;
      hex += pieces[i];
    }
    return match;
  });
}

/**
 * Wraps the raw tools so that everything they return passes the injection
 * check (if a guard is given) and then the Text Encoder. This is where "raw
 * fetched text never reaches a model" is enforced. The guard sees exactly the
 * text that would be encoded, raw: the classifier was trained on raw addresses,
 * and it runs locally.
 */
export function encodedTools(raw: RawTools, encoder: TextEncoderPort, guard?: ContentGuardPort): SubagentTools {
  const prepare = async (text: string, source: ContentSource & { kind: "web" | "pdf"; ref: string }) => {
    const trimmed = rejoinWrappedHex(text.slice(0, MAX_EXTERNAL_TEXT_CHARS));
    const checked = guard ? await guard.review(trimmed, source) : trimmed;
    return encoder.encode(checked, source);
  };
  return {
    web: { fetchPage: async (url) => prepare(await raw.fetchWebText(url), { kind: "web", ref: url }) },
    pdf: { readPdf: async (file) => prepare(await raw.extractPdfText(file), { kind: "pdf", ref: path.basename(file) }) },
  };
}
