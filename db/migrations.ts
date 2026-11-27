import type Database from "better-sqlite3";

// Schema changes for databases created by an older version of db/schema.sql.
// A fresh database is created from schema.sql directly and marked as the
// latest version. An existing one runs every migration above its version.

export const LATEST_VERSION = 3;

type Migration = { version: number; up: (db: Database.Database) => void };

const MIGRATIONS: Migration[] = [
  {
    // Version 2: actions may record recipients from web pages or PDFs
    // (provenance 'external') and steps skipped after an earlier failure.
    // SQLite cannot change a CHECK constraint, so the table is rebuilt.
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE actions_v2 (
          id             INTEGER PRIMARY KEY,
          session_id     TEXT NOT NULL,
          plan_id        TEXT NOT NULL,
          batch_index    INTEGER NOT NULL DEFAULT 0,
          kind           TEXT NOT NULL CHECK (kind IN ('transfer', 'sign_typed_data')),
          chain_id       INTEGER NOT NULL REFERENCES networks (chain_id),
          signer_address TEXT NOT NULL COLLATE NOCASE,
          token_id       INTEGER REFERENCES tokens (id),
          to_address     TEXT COLLATE NOCASE,
          to_label       TEXT,
          to_provenance  TEXT CHECK (to_provenance IN ('user', 'contact', 'external', 'untrusted')),
          amount         TEXT CHECK (amount IS NULL OR (amount <> '' AND amount NOT GLOB '*[^0-9]*')),
          td_primary_type TEXT,
          td_domain       TEXT,
          td_hash         TEXT,
          status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                         'proposed', 'blocked', 'rejected', 'expired', 'approved',
                         'signed', 'submitted', 'confirmed', 'failed', 'skipped')),
          approved_by  TEXT CHECK (approved_by IN ('user', 'auto')),
          tainted      INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1)),
          tx_hash      TEXT UNIQUE,
          block_number INTEGER,
          fee_wei      TEXT,
          error        TEXT,
          created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (plan_id, batch_index),
          CHECK (kind <> 'transfer'
                 OR (token_id IS NOT NULL AND to_address IS NOT NULL
                     AND to_provenance IS NOT NULL AND amount IS NOT NULL)),
          CHECK (kind <> 'sign_typed_data'
                 OR (td_primary_type IS NOT NULL AND td_domain IS NOT NULL AND td_hash IS NOT NULL)),
          CHECK (to_address IS NULL OR (length(to_address) = 42 AND to_address LIKE '0x%')),
          CHECK (NOT (tainted = 1 AND approved_by = 'auto'))
        ) STRICT;
        INSERT INTO actions_v2 (id, session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id,
          to_address, to_label, to_provenance, amount, td_primary_type, td_domain, td_hash, status, approved_by,
          tainted, tx_hash, block_number, fee_wei, error, created_at, updated_at)
        SELECT id, session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id,
          to_address, to_label, to_provenance, amount, td_primary_type, td_domain, td_hash, status, approved_by,
          tainted, tx_hash, block_number, fee_wei, error, created_at, updated_at FROM actions;
        DROP TABLE actions;
        ALTER TABLE actions_v2 RENAME TO actions;
        CREATE INDEX IF NOT EXISTS actions_activity ON actions (created_at DESC);
        CREATE INDEX IF NOT EXISTS actions_spend    ON actions (token_id, created_at) WHERE kind = 'transfer';
        CREATE TRIGGER IF NOT EXISTS actions_no_delete
        BEFORE DELETE ON actions
        BEGIN
          SELECT RAISE(ABORT, 'actions rows cannot be deleted');
        END;
      `);
    },
  },
  {
    // Version 3: Uniswap swaps are recorded as actions of kind 'swap', with the
    // token received, the least accepted and what actually arrived.
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE actions_v3 (
          id             INTEGER PRIMARY KEY,
          session_id     TEXT NOT NULL,
          plan_id        TEXT NOT NULL,
          batch_index    INTEGER NOT NULL DEFAULT 0,
          kind           TEXT NOT NULL CHECK (kind IN ('transfer', 'sign_typed_data', 'swap')),
          chain_id       INTEGER NOT NULL REFERENCES networks (chain_id),
          signer_address TEXT NOT NULL COLLATE NOCASE,
          token_id       INTEGER REFERENCES tokens (id),
          to_address     TEXT COLLATE NOCASE,
          to_label       TEXT,
          to_provenance  TEXT CHECK (to_provenance IN ('user', 'contact', 'external', 'untrusted')),
          amount         TEXT CHECK (amount IS NULL OR (amount <> '' AND amount NOT GLOB '*[^0-9]*')),
          td_primary_type TEXT,
          td_domain       TEXT,
          td_hash         TEXT,
          status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                         'proposed', 'blocked', 'rejected', 'expired', 'approved',
                         'signed', 'submitted', 'confirmed', 'failed', 'skipped')),
          approved_by  TEXT CHECK (approved_by IN ('user', 'auto')),
          tainted      INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1)),
          tx_hash      TEXT UNIQUE,
          block_number INTEGER,
          fee_wei      TEXT,
          error        TEXT,
          created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
          swap_token_out_id INTEGER REFERENCES tokens (id),
          swap_side         TEXT CHECK (swap_side IN ('exact_in', 'exact_out')),
          swap_min_out      TEXT CHECK (swap_min_out IS NULL OR (swap_min_out <> '' AND swap_min_out NOT GLOB '*[^0-9]*')),
          swap_amount_out   TEXT CHECK (swap_amount_out IS NULL OR (swap_amount_out <> '' AND swap_amount_out NOT GLOB '*[^0-9]*')),
          swap_fee_tier     INTEGER,
          UNIQUE (plan_id, batch_index),
          CHECK (kind <> 'transfer'
                 OR (token_id IS NOT NULL AND to_address IS NOT NULL
                     AND to_provenance IS NOT NULL AND amount IS NOT NULL)),
          CHECK (kind <> 'sign_typed_data'
                 OR (td_primary_type IS NOT NULL AND td_domain IS NOT NULL AND td_hash IS NOT NULL)),
          CHECK (to_address IS NULL OR (length(to_address) = 42 AND to_address LIKE '0x%')),
          CHECK (NOT (tainted = 1 AND approved_by = 'auto')),
          CHECK (kind <> 'swap'
                 OR (token_id IS NOT NULL AND amount IS NOT NULL AND swap_token_out_id IS NOT NULL
                     AND swap_side IS NOT NULL AND swap_min_out IS NOT NULL AND swap_fee_tier IS NOT NULL))
        ) STRICT;
        INSERT INTO actions_v3 (id, session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id,
          to_address, to_label, to_provenance, amount, td_primary_type, td_domain, td_hash, status, approved_by,
          tainted, tx_hash, block_number, fee_wei, error, created_at, updated_at)
        SELECT id, session_id, plan_id, batch_index, kind, chain_id, signer_address, token_id,
          to_address, to_label, to_provenance, amount, td_primary_type, td_domain, td_hash, status, approved_by,
          tainted, tx_hash, block_number, fee_wei, error, created_at, updated_at FROM actions;
        DROP TABLE actions;
        ALTER TABLE actions_v3 RENAME TO actions;
        CREATE INDEX IF NOT EXISTS actions_activity ON actions (created_at DESC);
        CREATE INDEX IF NOT EXISTS actions_spend    ON actions (token_id, created_at) WHERE kind = 'transfer';
        CREATE TRIGGER IF NOT EXISTS actions_no_delete
        BEFORE DELETE ON actions
        BEGIN
          SELECT RAISE(ABORT, 'actions rows cannot be deleted');
        END;
      `);
    },
  },
];

/** Brings the database to LATEST_VERSION. `fresh` means schema.sql just created every table. */
export function migrate(db: Database.Database, fresh: boolean): void {
  if (fresh) {
    db.pragma(`user_version = ${LATEST_VERSION}`);
    return;
  }
  let version = Number(db.pragma("user_version", { simple: true }));
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    // Foreign key checks are paused while a table is rebuilt, then verified.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      })();
      const problems = db.pragma("foreign_key_check") as unknown[];
      if (problems.length > 0) throw new Error(`Migration ${migration.version} broke foreign keys`);
    } finally {
      db.pragma("foreign_keys = ON");
    }
    version = migration.version;
  }
}
