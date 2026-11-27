import { httpsOnlyRefusal } from "@/lib/https-only";
import { NetworkPolicyError } from "./guarded-fetch";

/**
 * A fetch that only talks to one host. Given to the LLM client so the model
 * connection can reach the configured provider endpoint and nowhere else.
 */
export function hostLockedFetch(allowedHost: string): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.host !== allowedHost) {
      throw new NetworkPolicyError(`Model client tried to reach ${url.host}; only ${allowedHost} is allowed`);
    }
    // HTTPS only (Settings). The request pipeline checks this first with a clearer message; this is the backstop.
    const refusal = httpsOnlyRefusal(url.href, "The model endpoint");
    if (refusal) throw new NetworkPolicyError(refusal);
    return fetch(input, { ...init, redirect: "error" });
  };
}
