import { getSetting } from "@/db/settings";

// The "HTTPS only" setting: when on, the app refuses a model endpoint, a web
// page (including every redirect) or an RPC URL (network and ENS) that is not
// https://, and says why. On by
// default; a missing setting counts as on. Changing it needs an unlocked wallet
// (see changeGuard), so a page or a pasted message cannot turn it off.

export const HTTPS_ONLY_KEY = "https_only";

export function isHttpsOnly(): boolean {
  return getSetting(HTTPS_ONLY_KEY) !== "0";
}

/** Why `url` is refused under HTTPS only, or null if it may be used. `what` names it for the user. */
export function httpsOnlyRefusal(url: string, what: string): string | null {
  if (!isHttpsOnly()) return null;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return null; // not a URL at all: the caller's own validation reports it
  }
  if (protocol === "https:") return null;
  return `${what} uses ${protocol.replace(":", "")}, not https, and HTTPS only is on. Use an https:// address, or turn HTTPS only off in Settings.`;
}
