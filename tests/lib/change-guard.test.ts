import { beforeEach, describe, expect, it, vi } from "vitest";

const status = { exists: true, address: "0x0", unlocked: false };
vi.mock("@/wallet", async (original) => ({
  ...(await original<typeof import("@/wallet")>()),
  getWalletStatus: async () => ({ ...status }),
}));

const { changeGuard } = await import("@/lib/wallet-http");

const request = (origin?: string) =>
  new Request("http://localhost:3000/api/contacts", {
    method: "POST",
    headers: { host: "localhost:3000", ...(origin ? { origin } : {}) },
  });

beforeEach(() => {
  status.exists = true;
  status.unlocked = false;
});

describe("changeGuard: no saved-data changes while the wallet is locked", () => {
  it("refuses with 423 when a wallet exists and is locked", async () => {
    const response = await changeGuard(request(), "contacts");
    expect(response?.status).toBe(423);
    expect(await response?.json()).toMatchObject({ code: "WALLET_LOCKED" });
  });

  it("allows changes when the wallet is unlocked", async () => {
    status.unlocked = true;
    expect(await changeGuard(request(), "contacts")).toBeNull();
  });

  it("allows changes before any wallet exists (first-time setup)", async () => {
    status.exists = false;
    expect(await changeGuard(request(), "models")).toBeNull();
  });

  it("still refuses cross-site requests, even when unlocked", async () => {
    status.unlocked = true;
    expect((await changeGuard(request("https://evil.example"), "limits"))?.status).toBe(403);
  });
});
