import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

// Runs before the wallet tests import anything: a throwaway keystore path and
// an in-memory database, so tests never touch data/keystore.json or data/app.db.
process.env.WALLET_KEYSTORE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "wallet-test-")), "keystore.json");

const db = new Database(":memory:");
db.pragma("foreign_keys = ON");
db.exec(readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8"));
(globalThis as { __db?: Database.Database }).__db = db;
