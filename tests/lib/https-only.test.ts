import "../wallet/setup"; // in-memory database: never data/app.db
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { setSetting } from "@/db/settings";
import { assertAllowedUrl, guardedFetch, NetworkPolicyError } from "@/ai/net/guarded-fetch";
import { hostLockedFetch } from "@/ai/net/host-locked-fetch";
import { httpsOnlyRefusal, isHttpsOnly } from "@/lib/https-only";
import { getActiveNetwork, setRpcUrl } from "@/db/networks";
import { getBalance, WalletError } from "@/wallet";
import { ensClient, publicClientFor } from "@/wallet/clients";

afterEach(() => setSetting("https_only", "1"));

describe("HTTPS only setting", () => {
  it("is on by default, including when the setting is missing", () => {
    getDb().prepare("DELETE FROM settings WHERE key = 'https_only'").run();
    expect(isHttpsOnly()).toBe(true);
  });

  it("refuses http and allows https, with the reason", () => {
    expect(httpsOnlyRefusal("https://example.com/a", "The page")).toBeNull();
    expect(httpsOnlyRefusal("http://example.com/a", "The page http://example.com/a")).toBe(
      "The page http://example.com/a uses http, not https, and HTTPS only is on. Use an https:// address, or turn HTTPS only off in Settings.",
    );
  });

  it("allows http when turned off", () => {
    setSetting("https_only", "0");
    expect(httpsOnlyRefusal("http://example.com/a", "The page")).toBeNull();
  });
});

describe("enforcement", () => {
  it("refuses an http web page before connecting", async () => {
    await expect(guardedFetch("http://example.com/invoice", 1000)).rejects.toThrow(/The page http:\/\/example.com\/invoice uses http, not https/);
  });

  it("still applies the scraper's own rules when HTTPS only is off", () => {
    setSetting("https_only", "0");
    expect(() => assertAllowedUrl(new URL("http://10.0.0.1/"), "10.0.0.1")).toThrow(NetworkPolicyError);
  });

  it("refuses an http model endpoint in the model client too", () => {
    const locked = hostLockedFetch("localhost:11434");
    expect(() => locked("http://localhost:11434/api/chat")).toThrow(/The model endpoint uses http, not https/);
  });
});

describe("RPC URLs", () => {
  const network = () => getActiveNetwork();
  let saved = "";

  it("refuses an http network RPC URL before any request, with the reason", async () => {
    saved = network().rpcUrl;
    setRpcUrl(network().chainId, "http://127.0.0.1:8545");
    try {
      expect(() => publicClientFor(network())).toThrow(WalletError);
      const error = await getBalance({ token: "ETH", address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }).catch((e) => e);
      expect(error).toMatchObject({ code: "HTTPS_REQUIRED" });
      expect(error.message).toMatch(/RPC URL \(http:\/\/127.0.0.1:8545\) uses http, not https, and HTTPS only is on/);
    } finally {
      setRpcUrl(network().chainId, saved);
    }
  });

  it("allows it when HTTPS only is off", () => {
    saved = network().rpcUrl;
    setRpcUrl(network().chainId, "http://127.0.0.1:8545");
    setSetting("https_only", "0");
    try {
      expect(() => publicClientFor(network())).not.toThrow();
    } finally {
      setRpcUrl(network().chainId, saved);
    }
  });

  it("refuses an http ENS RPC URL", () => {
    setSetting("ens_rpc_url", "http://ens.example");
    try {
      expect(() => ensClient()).toThrow(/The ENS RPC URL \(http:\/\/ens.example\) uses http/);
    } finally {
      setSetting("ens_rpc_url", "https://ethereum-rpc.publicnode.com");
    }
  });
});

describe("settings API", () => {
  const patch = async (body: object) => {
    const { PATCH } = await import("@/app/api/settings/route");
    return PATCH(new Request("http://localhost/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  };

  it("refuses to save an http RPC URL while HTTPS only is on, and saves it when off", async () => {
    const before = getActiveNetwork().rpcUrl;
    const refused = await patch({ rpcUrl: "http://127.0.0.1:8545" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/not https, and HTTPS only is on/);
    expect(getActiveNetwork().rpcUrl).toBe(before);

    const off = await patch({ httpsOnly: false, rpcUrl: "http://127.0.0.1:8545" });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ httpsOnly: false, network: { rpcUrl: "http://127.0.0.1:8545" } });
    setRpcUrl(getActiveNetwork().chainId, before);
  });

  it("reports and changes the setting", async () => {
    expect(await (await patch({ httpsOnly: false })).json()).toMatchObject({ httpsOnly: false });
    expect(isHttpsOnly()).toBe(false);
    expect(await (await patch({ httpsOnly: true })).json()).toMatchObject({ httpsOnly: true });
  });
});
