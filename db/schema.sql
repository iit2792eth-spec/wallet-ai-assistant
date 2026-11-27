-- Initialises the local SQLite database. Safe to run more than once.
-- Conventions:
--   * Token amounts are TEXT holding a base-10 integer in the token's smallest
--     unit (wei for ETH). SQLite integers are 64-bit, which overflows above ~9.2 ETH.
--   * Timestamps are INTEGER unix seconds.
--   * Never stored here: private keys, seed phrases, keystore contents,
--     chat messages, raw prompts, mask-vault entries, signatures.
--   * The audit trail is NOT here: it is an append-only JSON Lines file
--     (data/audit.log) written by the redacting logger.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;   -- per connection: the app must set this too

-- ---------------------------------------------------------------------------
-- Settings: single-row-per-key app state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

-- ---------------------------------------------------------------------------
-- Model configs: how the AI Agent reaches an LLM
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_configs (
  id         INTEGER PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE,
  provider   TEXT NOT NULL CHECK (provider IN ('openai_compatible', 'ollama', 'anthropic', 'google')),
  model_name TEXT NOT NULL,
  base_url   TEXT,                 -- optional; empty = the provider's standard endpoint
  api_key    TEXT,                 -- plaintext for now (v1 decision)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

-- ---------------------------------------------------------------------------
-- Networks and tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS networks (
  chain_id      INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  rpc_url       TEXT NOT NULL,     -- user-editable
  explorer_url  TEXT,              -- only used to build "view transaction" links
  native_symbol TEXT NOT NULL DEFAULT 'ETH'
) STRICT;

CREATE TABLE IF NOT EXISTS tokens (
  id       INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES networks (chain_id),
  symbol   TEXT NOT NULL COLLATE NOCASE,
  address  TEXT COLLATE NOCASE     -- NULL means the native coin
           CHECK (address IS NULL OR (length(address) = 42 AND address LIKE '0x%')),
  decimals INTEGER NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  UNIQUE (chain_id, symbol)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS tokens_chain_address
  ON tokens (chain_id, address) WHERE address IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Contacts: a name plus an ENS name, an address, or both
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  ens_name   TEXT COLLATE NOCASE,
  address    TEXT COLLATE NOCASE
             CHECK (address IS NULL OR (length(address) = 42 AND address LIKE '0x%')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (ens_name IS NOT NULL OR address IS NOT NULL)
) STRICT;

-- ---------------------------------------------------------------------------
-- Spend limits: per token. A transfer may skip approval only if a row exists,
-- is enabled, and the transfer fits all three limits. No row = always ask.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spend_limits (
  token_id     INTEGER PRIMARY KEY REFERENCES tokens (id) ON DELETE CASCADE,
  per_tx_max   TEXT NOT NULL CHECK (per_tx_max  <> '' AND per_tx_max  NOT GLOB '*[^0-9]*'),
  daily_max    TEXT NOT NULL CHECK (daily_max   <> '' AND daily_max   NOT GLOB '*[^0-9]*'),
  weekly_max   TEXT NOT NULL CHECK (weekly_max  <> '' AND weekly_max  NOT GLOB '*[^0-9]*'),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

-- ---------------------------------------------------------------------------
-- Actions: every transfer or typed-data signature the access layer was asked
-- to perform. One row per action; a plan that proposes a batch shares plan_id.
-- This is the source for the Activity tab, wallet.getHistory() and the
-- daily / weekly spend totals.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS actions (
  id             INTEGER PRIMARY KEY,
  session_id     TEXT NOT NULL,
  plan_id        TEXT NOT NULL,
  batch_index    INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL CHECK (kind IN ('transfer', 'sign_typed_data', 'swap')),
  chain_id       INTEGER NOT NULL REFERENCES networks (chain_id),
  signer_address TEXT NOT NULL COLLATE NOCASE,

  -- transfer (a swap uses token_id and amount for the token paid: the exact amount in, or the most it may pay)
  token_id       INTEGER REFERENCES tokens (id),
  to_address     TEXT COLLATE NOCASE,
  to_label       TEXT,             -- contact name or ENS name shown to the user
  to_provenance  TEXT CHECK (to_provenance IN ('user', 'contact', 'external', 'untrusted')),
  amount         TEXT CHECK (amount IS NULL OR (amount <> '' AND amount NOT GLOB '*[^0-9]*')),

  -- sign_typed_data (the signature itself is not stored)
  td_primary_type TEXT,
  td_domain       TEXT,            -- JSON of the EIP-712 domain
  td_hash         TEXT,            -- EIP-712 digest

  -- outcome
  status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                 'proposed',       -- waiting for a decision
                 'blocked',        -- refused by the policy engine
                 'rejected',       -- user said no
                 'expired',        -- approval timed out
                 'approved',       -- cleared to sign
                 'signed',         -- signed; for typed data this is final
                 'submitted',      -- transaction broadcast
                 'confirmed',      -- transaction mined successfully
                 'failed',         -- signing, broadcast or execution failed
                 'skipped')),      -- approved but not run, because an earlier step failed
  approved_by  TEXT CHECK (approved_by IN ('user', 'auto')),
  tainted      INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1)),
  tx_hash      TEXT UNIQUE,
  block_number INTEGER,
  fee_wei      TEXT,
  error        TEXT,               -- sanitised message only
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),

  -- swap (Uniswap): the token received, the least accepted (or exact amount for an exact-output swap), what arrived
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
  -- tainted actions can never be auto-approved
  CHECK (NOT (tainted = 1 AND approved_by = 'auto')),
  CHECK (kind <> 'swap'
         OR (token_id IS NOT NULL AND amount IS NOT NULL AND swap_token_out_id IS NOT NULL
             AND swap_side IS NOT NULL AND swap_min_out IS NOT NULL AND swap_fee_tier IS NOT NULL))
) STRICT;

CREATE INDEX IF NOT EXISTS actions_activity ON actions (created_at DESC);
CREATE INDEX IF NOT EXISTS actions_spend    ON actions (token_id, created_at) WHERE kind = 'transfer';

CREATE TRIGGER IF NOT EXISTS actions_no_delete
BEFORE DELETE ON actions
BEGIN
  SELECT RAISE(ABORT, 'actions rows cannot be deleted');
END;

-- ---------------------------------------------------------------------------
-- Seed data
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO networks (chain_id, name, rpc_url, explorer_url, native_symbol)
VALUES (11155111, 'Sepolia', 'https://ethereum-sepolia-rpc.publicnode.com',
        'https://sepolia.etherscan.io', 'ETH');

INSERT OR IGNORE INTO tokens (chain_id, symbol, address, decimals) VALUES
  (11155111, 'ETH',  NULL, 18),
  (11155111, 'USDC', '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', 6),
  -- Circle's EURC on Sepolia (name/symbol "EURC", 6 decimals, EIP-2612 version "2"; checked on chain 2026-11-26).
  (11155111, 'EURC', '0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4', 6);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('active_chain_id',  '11155111'),
  ('active_model_id',  ''),        -- model_configs.id, empty until one is added
  ('approval_timeout_seconds', '300'),
  ('https_only', '1'),
  ('swap_slippage_bps', '50'),       -- Uniswap slippage, in basis points (50 = 0.5%); the user's typed words may override               -- refuse http:// model endpoints and web pages (Settings -> Security)
  ('ens_rpc_url', 'https://ethereum-rpc.publicnode.com'); -- Ethereum mainnet, ENS lookups only

-- Uniswap v3 contracts per network (swaps). Checked on chain 2026-11-26: the router and
-- quoter use this factory, and the router's WETH9 is this WETH.
CREATE TABLE IF NOT EXISTS dex_contracts (
  chain_id INTEGER PRIMARY KEY REFERENCES networks (chain_id),
  router   TEXT NOT NULL CHECK (length(router) = 42),   -- SwapRouter02
  quoter   TEXT NOT NULL CHECK (length(quoter) = 42),   -- QuoterV2
  factory  TEXT NOT NULL CHECK (length(factory) = 42),  -- UniswapV3Factory
  weth     TEXT NOT NULL CHECK (length(weth) = 42)      -- WETH9
) STRICT;

INSERT OR IGNORE INTO dex_contracts (chain_id, router, quoter, factory, weth) VALUES
  (11155111, '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', '0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3',
             '0x0227628f3F023bb0B980b67D528571c95c6DaC1c', '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14');

-- The schema version is managed in db/index.ts (see db/migrations.ts).
