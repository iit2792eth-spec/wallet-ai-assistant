import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { httpsOnlyRefusal } from "@/lib/https-only";
import { FETCH_TIMEOUT_MS, MAX_REDIRECTS } from "../config";
import { isBlockedAddress } from "./ip";

export class NetworkPolicyError extends Error {}

type LookupCallback = (error: Error | null, address?: unknown, family?: number) => void;

// Runs for every connection the scraper opens, after DNS and before connect,
// so a hostname cannot resolve to an internal address (including by DNS rebinding).
function guardedLookup(hostname: string, options: object, callback: LookupCallback): void {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const bad = addresses.find((entry) => isBlockedAddress(entry.address));
    if (bad || addresses.length === 0) {
      return callback(new NetworkPolicyError(`${hostname} resolves to a non-public address`));
    }
    if ((options as { all?: boolean }).all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

const scraperAgent = new Agent({ connect: { lookup: guardedLookup as never } });

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Checks a URL against the scraper's rules. `allowedHost` is the host of the URL the user gave. */
export function assertAllowedUrl(url: URL, allowedHost: string): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new NetworkPolicyError("Only http and https URLs can be fetched");
  }
  if (url.port !== "") throw new NetworkPolicyError("Only default ports can be fetched");
  if (url.username || url.password) throw new NetworkPolicyError("URLs with credentials cannot be fetched");
  if (stripWww(url.hostname) !== stripWww(allowedHost)) {
    throw new NetworkPolicyError(`Request to ${url.hostname} is outside the URL the user gave`);
  }
  // IP literals skip DNS, so the lookup guard never sees them.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal) && isBlockedAddress(literal)) {
    throw new NetworkPolicyError("Internal addresses cannot be fetched");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new NetworkPolicyError("Internal addresses cannot be fetched");
  }
}

export type FetchedDocument = { finalUrl: string; contentType: string; body: Buffer };

/**
 * The only way the Web Scraping subagent reaches the network. Fetches the
 * URL the user gave and nothing else: redirects are followed by hand and each
 * hop is checked against the same rules. Sends no cookies and no user data.
 */
export async function guardedFetch(userUrl: string, maxBytes: number): Promise<FetchedDocument> {
  let url: URL;
  try {
    url = new URL(userUrl);
  } catch {
    throw new NetworkPolicyError("Invalid URL");
  }
  const allowedHost = url.hostname;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(url, allowedHost);
    // HTTPS only (Settings): checked on every hop, so an https page cannot redirect to http.
    const refusal = httpsOnlyRefusal(url.href, hop === 0 ? `The page ${url.href}` : `The page redirected to ${url.href}, which`);
    if (refusal) throw new NetworkPolicyError(refusal);
    const response = await undiciFetch(url, {
      method: "GET",
      redirect: "manual",
      dispatcher: scraperAgent,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "document-fetcher", accept: "text/html,application/pdf,text/plain" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new NetworkPolicyError("Redirect without a location");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`The page returned status ${response.status}`);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("The page is too large");
      chunks.push(Buffer.from(chunk));
    }
    return {
      finalUrl: url.href,
      contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
      body: Buffer.concat(chunks),
    };
  }
  throw new NetworkPolicyError("Too many redirects");
}
