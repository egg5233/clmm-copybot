-- Up Migration
--
-- Initial schema: replaces the fourteen JSON files the bot used to keep under ./data/.
-- Each table carries a COMMENT naming the file it supersedes. Two files stay on disk
-- deliberately (token-names.json, tvl-cache.json) — they are rebuildable API caches,
-- not state, and are documented in docs/postgres-migration.md.
--
-- Timestamps are TIMESTAMPTZ everywhere. The bot speaks epoch-milliseconds; the
-- repository layer converts at the boundary so call sites keep their `ts: number`.

-- ---------------------------------------------------------------------------
-- positions — data/position-map.json
-- ---------------------------------------------------------------------------
CREATE TABLE positions (
  target_nft        TEXT PRIMARY KEY,
  our_nft           TEXT NOT NULL,
  dex               TEXT,
  pool              TEXT,
  target_wallet     TEXT,
  locked_sol        NUMERIC,
  tick_lower        INTEGER,
  tick_upper        INTEGER,
  target_liquidity  NUMERIC,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE positions IS
  'Replaces data/position-map.json — target position NFT to our position NFT mapping.';
COMMENT ON COLUMN positions.dex IS
  'NULL means byreal: legacy entries predate the dex tag and every reader treats untagged as byreal.';
COMMENT ON COLUMN positions.target_liquidity IS
  'Target liquidity at open time (u128). NUMERIC keeps it exact; the repo layer reads it back as a string for BN.';
COMMENT ON COLUMN positions.locked_sol IS
  'SOL rent locked by this position. NULL means never recorded — callers substitute a per-dex fallback.';

-- findByOurNft / deleteByOurNft
CREATE INDEX positions_our_nft_idx ON positions (our_nft);
-- hasDuplicateTickRange
CREATE INDEX positions_dup_tick_idx ON positions (target_wallet, pool, tick_lower, tick_upper);

-- ---------------------------------------------------------------------------
-- events — the `events` array inside data/event-log.json
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id             BIGSERIAL PRIMARY KEY,
  ts             TIMESTAMPTZ NOT NULL,
  type           TEXT NOT NULL,
  target_wallet  TEXT NOT NULL,
  target_nft     TEXT,
  our_nft        TEXT,
  tx_sig         TEXT,
  success        BOOLEAN NOT NULL,
  error          TEXT,
  pool           TEXT,
  dex            TEXT
);

COMMENT ON TABLE events IS
  'Replaces the events array in data/event-log.json. The old file was rewritten whole (~336KB) on every event; this table takes one INSERT.';

CREATE INDEX events_ts_idx ON events (ts DESC);

-- ---------------------------------------------------------------------------
-- event_pool_map — the `poolMap` object inside data/event-log.json
-- ---------------------------------------------------------------------------
CREATE TABLE event_pool_map (
  target_nft  TEXT PRIMARY KEY,
  pool        TEXT NOT NULL
);

COMMENT ON TABLE event_pool_map IS
  'Replaces the poolMap object in data/event-log.json — permanent NFT to pool lookup that outlives the 1000-event cap.';

-- ---------------------------------------------------------------------------
-- asset_snapshots — data/asset-trend.json
-- ---------------------------------------------------------------------------
CREATE TABLE asset_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  granularity        TEXT NOT NULL CHECK (granularity IN ('raw', 'hourly', 'daily')),
  ts                 TIMESTAMPTZ NOT NULL,

  -- Totals (always written)
  tokens_usd         NUMERIC NOT NULL,
  lp_value_usd       NUMERIC NOT NULL,
  unclaimed_usd      NUMERIC NOT NULL,
  bonus_usd          NUMERIC NOT NULL,
  locked_sol_usd     NUMERIC NOT NULL,
  total_usd          NUMERIC NOT NULL,

  -- Optional context
  sol_price          NUMERIC,
  sol_balance_usd    NUMERIC,

  -- Per-dex breakdown (v1.21.0+)
  byreal_lp_usd      NUMERIC,
  byreal_fees_usd    NUMERIC,
  byreal_locked_usd  NUMERIC,
  orca_lp_usd        NUMERIC,
  orca_fees_usd      NUMERIC,
  orca_locked_usd    NUMERIC,
  meteora_lp_usd     NUMERIC,
  meteora_fees_usd   NUMERIC,
  meteora_locked_usd NUMERIC,
  pcs_lp_usd         NUMERIC,
  pcs_fees_usd       NUMERIC,
  pcs_locked_usd     NUMERIC,
  dammv2_lp_usd      NUMERIC,
  dammv2_fees_usd    NUMERIC,
  dammv2_locked_usd  NUMERIC,

  CONSTRAINT asset_snapshots_granularity_ts_key UNIQUE (granularity, ts)
);

COMMENT ON TABLE asset_snapshots IS
  'Replaces data/asset-trend.json — the raw/hourly/daily tiers become rows discriminated by granularity instead of three arrays rewritten together every 5 minutes.';
COMMENT ON COLUMN asset_snapshots.granularity IS
  'raw = 5-minute samples (capped 576), hourly = end-of-hour samples (capped 720), daily = end-of-day samples (unbounded).';

CREATE INDEX asset_snapshots_granularity_ts_idx ON asset_snapshots (granularity, ts DESC);

-- ---------------------------------------------------------------------------
-- pending_swaps — data/pending-swaps.json
-- ---------------------------------------------------------------------------
CREATE TABLE pending_swaps (
  input_mint  TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE pending_swaps IS
  'Replaces data/pending-swaps.json. Five executor modules read-modify-write that file with no locking; here each mint is its own row, so a write to one mint cannot clobber another.';
COMMENT ON COLUMN pending_swaps.payload IS
  'JSONB because the on-disk value is untyped Record<string, any> today: {pending, botReceived, createdAt} plus fields individual executors bolt on. Promoting it to real columns needs a shape audit across all five writers — future work.';

-- ---------------------------------------------------------------------------
-- swap_history — data/swap-history.json
-- ---------------------------------------------------------------------------
CREATE TABLE swap_history (
  id                BIGSERIAL PRIMARY KEY,
  ts                TIMESTAMPTZ NOT NULL,
  input_mint        TEXT NOT NULL,
  tx_sig            TEXT NOT NULL,
  input_amount_raw  TEXT,
  input_decimals    INTEGER,
  output_amount_raw TEXT
);

COMMENT ON TABLE swap_history IS
  'Replaces data/swap-history.json (cap 40). Two writers appended to that file independently — src/index.ts and the dashboard force-swap route.';
COMMENT ON COLUMN swap_history.input_amount_raw IS
  'Raw base-unit amount as TEXT: these are u64 strings that must survive a round trip without going through a JS number.';

CREATE INDEX swap_history_ts_idx ON swap_history (ts DESC);

-- ---------------------------------------------------------------------------
-- auth_log — data/auth-log.json
-- ---------------------------------------------------------------------------
CREATE TABLE auth_log (
  id     BIGSERIAL PRIMARY KEY,
  ts     TIMESTAMPTZ NOT NULL,
  ip     TEXT NOT NULL,
  event  TEXT NOT NULL
);

COMMENT ON TABLE auth_log IS
  'Replaces data/auth-log.json (cap 200) — dashboard login attempts, kept separate from bot logs.';

CREATE INDEX auth_log_ts_idx ON auth_log (ts DESC);

-- ---------------------------------------------------------------------------
-- claim_history — data/claim-history.json
-- ---------------------------------------------------------------------------
CREATE TABLE claim_history (
  id       BIGSERIAL PRIMARY KEY,
  week     TEXT NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  payload  JSONB NOT NULL
);

COMMENT ON TABLE claim_history IS
  'Replaces data/claim-history.json (cap 52 — one year of weekly copy-bonus claims).';
COMMENT ON COLUMN claim_history.payload IS
  'JSONB: the entry carries totalPools/totalBonusUsd/txSignatures[]/snapshotTs/error. week and ts are lifted out because they are the only fields queried; the rest is display-only, so typing it can wait.';

CREATE INDEX claim_history_ts_idx ON claim_history (ts DESC);

-- ---------------------------------------------------------------------------
-- dac_history — data/dac-history.json
-- ---------------------------------------------------------------------------
CREATE TABLE dac_history (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL,
  payload  JSONB NOT NULL
);

COMMENT ON TABLE dac_history IS
  'Replaces data/dac-history.json (cap 365) — Daily Auto-Convert runs.';
COMMENT ON COLUMN dac_history.payload IS
  'JSONB: DacRecord is a wide display-only record (profit, amounts, two signatures, status, reason). Nothing queries its fields, so promoting them to columns buys nothing yet.';

CREATE INDEX dac_history_ts_idx ON dac_history (ts DESC);

-- ---------------------------------------------------------------------------
-- token_pnl — data/token-pnl.json
-- ---------------------------------------------------------------------------
CREATE TABLE token_pnl (
  mint        TEXT PRIMARY KEY,
  payload     JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE token_pnl IS
  'Replaces data/token-pnl.json — per-token realised PnL driving the loss-streak cooldown.';
COMMENT ON COLUMN token_pnl.payload IS
  'JSONB: stored today as Record<mint, any> holding {totalPnl, tradeCount, lastLossPnl, lastTradeAt}. The dashboard merges extra fields into it on read, so the shape is not closed — typing is future work.';

-- ---------------------------------------------------------------------------
-- opened_referers — data/opened-referers.json
-- ---------------------------------------------------------------------------
CREATE TABLE opened_referers (
  referer_position  TEXT PRIMARY KEY,
  target_nft        TEXT NOT NULL,
  our_nft           TEXT NOT NULL,
  target_wallet     TEXT NOT NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE opened_referers IS
  'Replaces data/opened-referers.json — dedup guard so two target wallets sharing a referer do not both get copied.';
COMMENT ON COLUMN opened_referers.our_nft IS
  'May be an empty string: the referer is recorded before the open TX confirms and our NFT address is not always known yet.';

-- removeReferer() looks the row up by the target NFT, not the primary key.
CREATE INDEX opened_referers_target_nft_idx ON opened_referers (target_nft);

-- ---------------------------------------------------------------------------
-- pump_pending — data/pump-pending.json
-- ---------------------------------------------------------------------------
CREATE TABLE pump_pending (
  mint           TEXT PRIMARY KEY,
  symbol         TEXT NOT NULL,
  pool           TEXT NOT NULL,
  target_wallet  TEXT NOT NULL,
  detected_at    TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  notified_at    TIMESTAMPTZ,
  resolved_at    TIMESTAMPTZ
);

COMMENT ON TABLE pump_pending IS
  'Replaces data/pump-pending.json — pump.fun tokens awaiting Discord approval.';
COMMENT ON COLUMN pump_pending.detected_at IS
  'Drives the 1-hour expiry: a pending row older than that is treated as not-pending on read and auto-rejected by the poller.';

CREATE INDEX pump_pending_status_idx ON pump_pending (status);

-- Down Migration
DROP TABLE IF EXISTS pump_pending;
DROP TABLE IF EXISTS opened_referers;
DROP TABLE IF EXISTS token_pnl;
DROP TABLE IF EXISTS dac_history;
DROP TABLE IF EXISTS claim_history;
DROP TABLE IF EXISTS auth_log;
DROP TABLE IF EXISTS swap_history;
DROP TABLE IF EXISTS pending_swaps;
DROP TABLE IF EXISTS asset_snapshots;
DROP TABLE IF EXISTS event_pool_map;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS positions;
