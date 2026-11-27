import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { LATEST_VERSION, migrate } from "@/db/migrations";

const schema = readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");

/** A database as version 1 of the schema created it: no 'external' provenance, no 'skipped' status. */
function versionOneDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    schema
      .replace("'user', 'contact', 'external', 'untrusted'", "'user', 'contact', 'untrusted'")
      .replace(/,\s*-- signing, broadcast or execution failed\s*'skipped'\)\),/, ")),"),
  );
  db.pragma("user_version = 1");
  db.prepare(
    `INSERT INTO actions (session_id, plan_id, kind, chain_id, signer_address, token_id, to_address, to_provenance, amount, status)
     VALUES ('s', 'p', 'transfer', 11155111, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'user', '5', 'confirmed')`,
  ).run();
  return db;
}

const insertExternalSkipped = (db: Database.Database) =>
  db
    .prepare(
      `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, to_address, to_provenance, amount, status, tainted)
       VALUES ('s', 'q', 1, 'transfer', 11155111, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'external', '1', 'skipped', 1)`,
    )
    .run();

describe("schema migrations", () => {
  it("version 1 rejects the new values (the test fixture is really the old schema)", () => {
    expect(() => insertExternalSkipped(versionOneDatabase())).toThrow(/CHECK constraint/);
  });

  it("migrates version 1 to the latest version and keeps existing rows", () => {
    const db = versionOneDatabase();
    migrate(db, false);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT amount, status FROM actions").all()).toEqual([{ amount: "5", status: "confirmed" }]);
    insertExternalSkipped(db);
    expect(() => db.exec("DELETE FROM actions")).toThrow(/cannot be deleted/);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("is a no-op when run again", () => {
    const db = versionOneDatabase();
    migrate(db, false);
    migrate(db, false);
    expect(db.prepare("SELECT count(*) AS n FROM actions").get()).toEqual({ n: 1 });
  });

  it("marks a fresh database as the latest version", () => {
    const db = new Database(":memory:");
    db.exec(schema);
    migrate(db, true);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    insertExternalSkipped(db);
  });
});

describe("version 3: swaps", () => {
  /** A database as version 2 created it: no swap kind and no swap columns. */
  function versionTwoDatabase(): Database.Database {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const v2 = schema
      .replace("CHECK (kind IN ('transfer', 'sign_typed_data', 'swap'))", "CHECK (kind IN ('transfer', 'sign_typed_data'))")
      .replace(/\n\s*-- swap \(Uniswap\)[^\n]*\n(?:\s*swap_[^\n]*\n)+/, "\n")
      .replace(/,\s*CHECK \(kind <> 'swap'[\s\S]*?swap_fee_tier IS NOT NULL\)\)/, "");
    expect(v2).not.toContain("swap_token_out_id");
    db.exec(v2);
    db.pragma("user_version = 2");
    db.prepare(
      `INSERT INTO actions (session_id, plan_id, kind, chain_id, signer_address, token_id, to_address, to_provenance, amount, status)
       VALUES ('s', 'p', 'transfer', 11155111, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 'user', '5', 'confirmed')`,
    ).run();
    return db;
  }
  const insertSwap = (db: Database.Database, minOut: string | null) =>
    db
      .prepare(
        `INSERT INTO actions (session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id, amount, swap_token_out_id, swap_side, swap_min_out, swap_fee_tier, status)
         VALUES ('s', 'w', 0, 'swap', 11155111, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 1, '10000000000000000', 2, 'exact_in', ?, 500, 'proposed')`,
      )
      .run(minOut);

  it("migrates version 2, keeps rows, and then accepts complete swap rows only", () => {
    const db = versionTwoDatabase();
    expect(() => insertSwap(db, "494000000")).toThrow();
    migrate(db, false);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect(db.prepare("SELECT amount, status FROM actions").all()).toEqual([{ amount: "5", status: "confirmed" }]);
    insertSwap(db, "494000000");
    expect(() => insertSwap(db, null)).toThrow(/CHECK constraint/);
    expect(() => db.exec("DELETE FROM actions")).toThrow(/cannot be deleted/);
  });

  it("seeds the Sepolia Uniswap contracts and the slippage setting", () => {
    const db = new Database(":memory:");
    db.exec(schema);
    expect(db.prepare("SELECT router, quoter FROM dex_contracts WHERE chain_id = 11155111").get()).toEqual({
      router: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
      quoter: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
    });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'swap_slippage_bps'").get()).toEqual({ value: "50" });
  });
});
