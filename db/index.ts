import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrations";

// Local runtime files (database, audit log, keystore) live here; git-ignored.
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "app.db");
const SCHEMA_PATH = path.join(process.cwd(), "db", "schema.sql");

function open(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  // Foreign keys are off by default in SQLite and must be enabled per connection.
  db.pragma("foreign_keys = ON");
  const fresh = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get() === undefined;
  // The schema is idempotent, so running it on every start is safe.
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db, fresh);
  return db;
}

// Keep one connection per process. In dev, module reloads would otherwise
// open a new connection each time this file is re-evaluated.
const globalForDb = globalThis as unknown as { __db?: Database.Database };

export function getDb(): Database.Database {
  return (globalForDb.__db ??= open());
}
