import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Never touch data/app.db.
let db: Database.Database;
vi.mock("@/db/index", () => ({ getDb: () => db }));
const { listTokenLimits, setLimitEnabled, upsertLimit } = await import("@/db/limits");

const schema = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
const SEPOLIA = 11155111;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(schema);
});

describe("setLimitEnabled", () => {
  it("turns a saved limit off and on without changing its amounts", () => {
    const eth = listTokenLimits(SEPOLIA).find((l) => l.symbol === "ETH")!;
    upsertLimit(eth.tokenId, { perTxMax: "1", dailyMax: "2", weeklyMax: "3", enabled: true });

    expect(setLimitEnabled(eth.tokenId, false)).toBe(true);
    let row = listTokenLimits(SEPOLIA).find((l) => l.symbol === "ETH")!;
    expect(row).toMatchObject({ enabled: false, perTxMax: "1", dailyMax: "2", weeklyMax: "3" });

    expect(setLimitEnabled(eth.tokenId, true)).toBe(true);
    row = listTokenLimits(SEPOLIA).find((l) => l.symbol === "ETH")!;
    expect(row.enabled).toBe(true);
  });

  it("returns false when the token has no saved limit (nothing is created)", () => {
    const usdc = listTokenLimits(SEPOLIA).find((l) => l.symbol === "USDC")!;
    expect(setLimitEnabled(usdc.tokenId, true)).toBe(false);
    expect(listTokenLimits(SEPOLIA).find((l) => l.symbol === "USDC")!.perTxMax).toBeNull();
  });
});
