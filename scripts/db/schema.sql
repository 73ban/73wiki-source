-- 73WIKI trading brain database schema
-- This schema stores high-volume structured market data. RAW files remain the
-- source evidence layer, while data/facts/*.jsonl remains the RAG summary layer.

create schema if not exists trading;

create table if not exists trading.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists trading.source_evidence (
  id text primary key,
  source_kind text not null,
  source_name text,
  source_path text,
  source_url text,
  source_hash text,
  captured_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  note text
);

create table if not exists trading.market_snapshot_batches (
  id text primary key,
  snapshot_at timestamptz not null,
  trade_date date,
  session_label text,
  source text not null,
  scope text not null,
  status text not null default 'active',
  summary text,
  raw_fact_path text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_market_snapshot_batches_time
  on trading.market_snapshot_batches (snapshot_at desc);

create table if not exists trading.instruments (
  code text primary key,
  name text,
  market text,
  exchange text,
  instrument_type text not null default 'stock',
  industry text,
  concepts text[] not null default '{}',
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists trading.quote_snapshots (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  scope text not null default 'watchlist',
  price numeric,
  change_percent numeric,
  open_price numeric,
  high_price numeric,
  low_price numeric,
  prev_close numeric,
  volume numeric,
  amount numeric,
  turnover_rate numeric,
  volume_ratio numeric,
  industry text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, code, source, scope)
);

create index if not exists idx_quote_snapshots_code_time
  on trading.quote_snapshots (code, snapshot_at desc);

create index if not exists idx_quote_snapshots_batch
  on trading.quote_snapshots (batch_id);

create table if not exists trading.minute_bars (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  source_batch_id text,
  trade_date date not null,
  snapshot_at timestamptz not null,
  minute text not null,
  code text not null,
  name text,
  interval text not null default '1m',
  source text not null,
  source_quality text,
  open_price numeric,
  high_price numeric,
  low_price numeric,
  close_price numeric,
  volume numeric,
  amount numeric,
  cumulative_volume numeric,
  cumulative_amount numeric,
  synthetic_ohlc boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (trade_date, code, minute, interval, source)
);

create index if not exists idx_minute_bars_code_date
  on trading.minute_bars (code, trade_date desc, minute asc);

create index if not exists idx_minute_bars_batch
  on trading.minute_bars (batch_id);

create table if not exists trading.index_snapshots (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  snapshot_at timestamptz not null,
  index_code text,
  index_name text not null,
  source text not null,
  price numeric,
  change_percent numeric,
  amount numeric,
  volume numeric,
  up_count integer,
  down_count integer,
  limit_up_count integer,
  limit_down_count integer,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, index_name, source)
);

create table if not exists trading.sector_snapshots (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  snapshot_at timestamptz not null,
  sector_code text,
  sector_name text not null,
  sector_type text,
  source text not null,
  change_percent numeric,
  amount numeric,
  up_count integer,
  down_count integer,
  limit_up_count integer,
  limit_down_count integer,
  leader_code text,
  leader_name text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, sector_name, source)
);

create table if not exists trading.limit_up_pool (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  trade_date date not null,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  price numeric,
  change_percent numeric,
  amount numeric,
  turnover_rate numeric,
  limit_up_height integer,
  first_limit_time time,
  last_limit_time time,
  seal_amount numeric,
  burst_count integer,
  industry text,
  limit_up_stat text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, trade_date, code, source)
);

create index if not exists idx_limit_up_pool_date_height
  on trading.limit_up_pool (trade_date desc, limit_up_height desc, first_limit_time asc);

create table if not exists trading.burst_pool (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  trade_date date not null,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  price numeric,
  change_percent numeric,
  amount numeric,
  turnover_rate numeric,
  first_limit_time time,
  burst_count integer,
  amplitude numeric,
  speed numeric,
  industry text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, trade_date, code, source)
);

create table if not exists trading.limit_down_pool (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  trade_date date not null,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  price numeric,
  change_percent numeric,
  amount numeric,
  turnover_rate numeric,
  seal_amount numeric,
  last_limit_time time,
  continuous_down_days integer,
  open_board_count integer,
  industry text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, trade_date, code, source)
);

create table if not exists trading.strong_pool (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  trade_date date not null,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  price numeric,
  change_percent numeric,
  amount numeric,
  turnover_rate numeric,
  volume_ratio numeric,
  reason text,
  industry text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, trade_date, code, source)
);

create table if not exists trading.limit_up_reasons (
  id text primary key,
  trade_date date not null,
  observed_at timestamptz not null,
  code text not null,
  name text,
  reason text not null,
  theme text,
  concepts text[] not null default '{}',
  source text not null,
  source_level text not null default 'C',
  confidence numeric,
  related_raw_path text,
  evidence_refs text[] not null default '{}',
  status text not null default 'active',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_limit_up_reasons_date_code
  on trading.limit_up_reasons (trade_date desc, code);

create index if not exists idx_limit_up_reasons_theme
  on trading.limit_up_reasons (trade_date desc, theme);

create table if not exists trading.auction_snapshots (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  trade_date date not null,
  snapshot_at timestamptz not null,
  code text not null,
  name text,
  source text not null,
  price numeric,
  change_percent numeric,
  matched_volume numeric,
  unmatched_volume numeric,
  matched_amount numeric,
  buy_queue_amount numeric,
  sell_queue_amount numeric,
  signal text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, trade_date, code, source)
);

create table if not exists trading.warroom_quotes (
  id bigserial primary key,
  batch_id text references trading.market_snapshot_batches(id) on delete cascade,
  snapshot_at timestamptz not null,
  trade_date date,
  code text not null,
  name text,
  watchlist_source text,
  role text,
  source text not null,
  price numeric,
  change_percent numeric,
  state text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (batch_id, code, source)
);

create table if not exists trading.warroom_watchlists (
  id text primary key,
  generated_at timestamptz not null,
  trade_date date,
  title text,
  source text not null,
  status text not null default 'active',
  summary text,
  data_quality jsonb not null default '{}'::jsonb,
  source_files text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_warroom_watchlists_date
  on trading.warroom_watchlists (trade_date desc, generated_at desc);

create table if not exists trading.warroom_watchlist_items (
  id text primary key,
  watchlist_id text references trading.warroom_watchlists(id) on delete cascade,
  generated_at timestamptz not null,
  trade_date date,
  code text not null,
  name text,
  tier text not null,
  role text,
  priority_rank integer,
  score numeric,
  occurrences integer,
  reasons text[] not null default '{}',
  source_files text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (watchlist_id, code, tier)
);

create index if not exists idx_warroom_watchlist_items_code_date
  on trading.warroom_watchlist_items (code, trade_date desc);

create index if not exists idx_warroom_watchlist_items_tier_date
  on trading.warroom_watchlist_items (tier, trade_date desc, priority_rank asc, score desc);

create table if not exists trading.preopen_intel (
  id text primary key,
  generated_at timestamptz not null,
  trade_date date,
  title text,
  source text not null,
  status text not null default 'active',
  core_limit integer,
  symbols text[] not null default '{}',
  source_files text[] not null default '{}',
  claim text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_preopen_intel_date
  on trading.preopen_intel (trade_date desc, generated_at desc);

create table if not exists trading.preopen_intel_items (
  id text primary key,
  intel_id text references trading.preopen_intel(id) on delete cascade,
  generated_at timestamptz not null,
  trade_date date,
  rank integer,
  code text not null,
  name text,
  role text,
  score numeric,
  themes text[] not null default '{}',
  positives text[] not null default '{}',
  risks text[] not null default '{}',
  source_tags text[] not null default '{}',
  source_files text[] not null default '{}',
  hypothesis text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (intel_id, code)
);

create index if not exists idx_preopen_intel_items_code_date
  on trading.preopen_intel_items (code, trade_date desc, rank asc);

create table if not exists trading.stock_reason_cards (
  id text primary key,
  generated_at timestamptz not null,
  trade_date date,
  code text not null,
  name text,
  rank integer,
  role text,
  confidence numeric,
  inferred_reason text,
  themes text[] not null default '{}',
  catalysts text[] not null default '{}',
  risks text[] not null default '{}',
  evidence_files text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_reason_cards_code_date
  on trading.stock_reason_cards (code, trade_date desc, confidence desc);

create index if not exists idx_stock_reason_cards_theme_date
  on trading.stock_reason_cards using gin (themes);

create table if not exists trading.catalyst_events (
  id text primary key,
  generated_at timestamptz not null,
  event_time timestamptz,
  trade_date date,
  title text,
  event_type text not null,
  source text not null,
  source_tier text not null default 'S3',
  source_path text,
  source_url text,
  themes text[] not null default '{}',
  keywords text[] not null default '{}',
  catalyst_score numeric,
  summary text,
  status text not null default 'active',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_catalyst_events_date_score
  on trading.catalyst_events (trade_date desc, catalyst_score desc);

create index if not exists idx_catalyst_events_themes
  on trading.catalyst_events using gin (themes);

create table if not exists trading.stock_event_links (
  id text primary key,
  event_id text references trading.catalyst_events(id) on delete cascade,
  generated_at timestamptz not null,
  trade_date date,
  code text not null,
  name text,
  link_type text not null default 'theme_match',
  relation_strength numeric,
  reasons text[] not null default '{}',
  themes text[] not null default '{}',
  source_tags text[] not null default '{}',
  evidence_files text[] not null default '{}',
  status text not null default 'candidate',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (event_id, code)
);

create index if not exists idx_stock_event_links_code_date
  on trading.stock_event_links (code, trade_date desc, relation_strength desc);

create index if not exists idx_stock_event_links_event
  on trading.stock_event_links (event_id);

create table if not exists trading.prediction_candidates (
  id text primary key,
  generated_at timestamptz not null,
  trade_date date,
  title text,
  source text not null,
  status text not null default 'active',
  candidate_limit integer,
  symbols text[] not null default '{}',
  source_files text[] not null default '{}',
  claim text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_prediction_candidates_date
  on trading.prediction_candidates (trade_date desc, generated_at desc);

create table if not exists trading.prediction_candidate_items (
  id text primary key,
  candidate_id text references trading.prediction_candidates(id) on delete cascade,
  generated_at timestamptz not null,
  trade_date date,
  rank integer,
  code text not null,
  name text,
  role text,
  predicted_move text,
  score numeric,
  novelty numeric,
  expectation_gap numeric,
  next_day_tradeability numeric,
  themes text[] not null default '{}',
  positives text[] not null default '{}',
  risks text[] not null default '{}',
  reasons text[] not null default '{}',
  invalidations text[] not null default '{}',
  source_tags text[] not null default '{}',
  source_files text[] not null default '{}',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (candidate_id, code)
);

create index if not exists idx_prediction_candidate_items_code_date
  on trading.prediction_candidate_items (code, trade_date desc, rank asc);

create table if not exists trading.intraday_validations (
  id text primary key,
  generated_at timestamptz not null,
  trade_date date not null,
  source text not null,
  status text not null default 'active',
  summary text,
  symbols text[] not null default '{}',
  counts jsonb not null default '{}'::jsonb,
  key_times text[] not null default '{}',
  market_emotion jsonb not null default '[]'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_intraday_validations_date
  on trading.intraday_validations (trade_date desc, generated_at desc);

create table if not exists trading.intraday_validation_items (
  id text primary key,
  validation_id text references trading.intraday_validations(id) on delete cascade,
  generated_at timestamptz not null,
  trade_date date not null,
  code text not null,
  name text,
  rank integer,
  role text,
  status text not null,
  underlying_status text,
  verdict text,
  score numeric,
  latest_change numeric,
  max_change numeric,
  min_change numeric,
  limit_hit boolean,
  burst_hit boolean,
  key_facts text[] not null default '{}',
  evidence_times jsonb not null default '[]'::jsonb,
  reason jsonb not null default '{}'::jsonb,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (validation_id, code)
);

create index if not exists idx_intraday_validation_items_code_date
  on trading.intraday_validation_items (code, trade_date desc, generated_at desc);

create index if not exists idx_intraday_validation_items_status_date
  on trading.intraday_validation_items (status, trade_date desc, score desc);

create table if not exists trading.trades (
  id text primary key,
  trade_date date not null,
  trade_time time,
  code text not null,
  name text,
  side text not null,
  quantity numeric,
  price numeric,
  amount numeric,
  fee numeric,
  account text,
  source_path text,
  source_hash text,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_trades_date_code
  on trading.trades (trade_date desc, code);

create table if not exists trading.review_judgements (
  id text primary key,
  trade_id text references trading.trades(id) on delete set null,
  trade_date date not null,
  code text,
  judgement_type text not null,
  verdict text not null,
  score numeric,
  reason text,
  evidence_refs text[] not null default '{}',
  related_pattern text,
  created_at timestamptz not null default now(),
  raw jsonb not null default '{}'::jsonb
);

create table if not exists trading.collection_runs (
  id text primary key,
  planned_at timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  run_type text not null,
  status text not null default 'running',
  source text,
  summary text,
  error text,
  payload jsonb not null default '{}'::jsonb
);

insert into trading.schema_migrations(version)
values ('001_initial_trading_brain_schema')
on conflict (version) do nothing;
