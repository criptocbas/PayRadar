-- PayRadar v0 schema
-- Plain Postgres + JSONB; no TimescaleDB in v0 (Supabase managed PG works fine
-- at MVP volumes). Switch probes -> hypertable when probe volume crosses ~10M rows.

-- ============================================================================
-- providers
-- ============================================================================
create table providers (
  id                    text primary key,
  slug                  text not null unique,
  name                  text not null,
  homepage              text,
  pay_sh_id             text unique,
  pay_skills_repo_path  text,
  claimed               boolean not null default false,
  claimed_by_wallet     text,
  claimed_at            timestamptz,
  categories            text[] not null default '{}',
  description           text,
  payment_recipients    jsonb not null default '[]'::jsonb,
  endpoint_count        integer not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index providers_categories_idx on providers using gin (categories);

-- ============================================================================
-- endpoints
-- ============================================================================
create table endpoints (
  id                     text primary key,
  provider_id            text not null references providers(id) on delete cascade,
  operation_id           text not null,
  method                 text not null check (method in ('GET','POST','PUT','PATCH','DELETE')),
  path                   text not null,
  url                    text not null,
  capabilities           text[] not null default '{}',
  pricing                jsonb not null,
  documented_sla         jsonb,
  active                 boolean not null default true,
  first_seen             timestamptz not null default now(),
  last_seen_in_catalog   timestamptz not null default now(),
  openapi_hash           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index endpoints_provider_idx     on endpoints(provider_id);
create index endpoints_capabilities_idx on endpoints using gin (capabilities);
create index endpoints_active_idx       on endpoints(active) where active = true;
-- Functional index for cheap price-band filtering without unwrapping JSONB at query time.
create index endpoints_price_idx on endpoints (((pricing->>'amount_usd')::numeric)) where active = true;

-- ============================================================================
-- probes
-- ============================================================================
create table probes (
  probe_id        text primary key,
  endpoint_id     text not null references endpoints(id) on delete cascade,
  ts              timestamptz not null,
  probe_type      text not null check (probe_type in ('liveness','synthetic_paid','security','telemetry')),
  source_region   text,
  source_class    text check (source_class in ('cloud','residential','sdk-attested')),
  ok              boolean not null,
  http_status     integer,
  latency_ms      integer,
  tls_valid       boolean,
  tls_expires_at  timestamptz,
  payment_tx_sig  text,
  response_hash   text,
  raw_blob_uri    text,
  inserted_at     timestamptz not null default now()
);

create index probes_endpoint_ts_idx on probes(endpoint_id, ts desc);
create index probes_ts_idx          on probes(ts desc);

-- ============================================================================
-- scores_current — exactly one row per endpoint, the latest signed score.
-- ============================================================================
create table scores_current (
  endpoint_id      text primary key references endpoints(id) on delete cascade,
  score_id         text not null,
  computed_at      timestamptz not null,
  engine_version   text not null,
  score            numeric(5,1) not null check (score >= 0 and score <= 100),
  confidence       numeric(3,2) not null check (confidence >= 0 and confidence <= 1),
  tier             text not null check (tier in ('S','A','B','C','D','F','PROVISIONAL')),
  dimensions       jsonb not null,
  signature        jsonb
);

create index scores_current_score_idx on scores_current(score desc);
create index scores_current_tier_idx  on scores_current(tier);

-- ============================================================================
-- scores_history — append-only, every recomputation lands here.
-- Replay queries hit this table.
-- ============================================================================
create table scores_history (
  score_id         text primary key,
  endpoint_id      text not null references endpoints(id) on delete cascade,
  computed_at      timestamptz not null,
  engine_version   text not null,
  score            numeric(5,1) not null,
  confidence       numeric(3,2) not null,
  tier             text not null,
  dimensions       jsonb not null,
  signature        jsonb
);

create index scores_history_endpoint_ts_idx on scores_history(endpoint_id, computed_at desc);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
create or replace function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger providers_set_updated_at
  before update on providers
  for each row execute function set_updated_at();

create trigger endpoints_set_updated_at
  before update on endpoints
  for each row execute function set_updated_at();

-- ============================================================================
-- RLS — all tables public-readable, writes restricted to the service role.
-- Supabase service-role key bypasses RLS, so the ingestor writes freely.
-- ============================================================================
alter table providers       enable row level security;
alter table endpoints       enable row level security;
alter table probes          enable row level security;
alter table scores_current  enable row level security;
alter table scores_history  enable row level security;

create policy "public read providers"      on providers      for select using (true);
create policy "public read endpoints"      on endpoints      for select using (true);
create policy "public read probes"         on probes         for select using (true);
create policy "public read scores_current" on scores_current for select using (true);
create policy "public read scores_history" on scores_history for select using (true);

-- ============================================================================
-- Convenience view: discover_view — the shape /v1/discover serves.
-- Projects only the columns the API needs and joins in latest score.
-- ============================================================================
create or replace view discover_view as
select
  e.id                as endpoint_id,
  e.provider_id,
  e.operation_id,
  e.method,
  e.path,
  e.url,
  e.capabilities,
  e.pricing,
  e.active,
  e.first_seen,
  e.last_seen_in_catalog,
  p.slug              as provider_slug,
  p.name              as provider_name,
  p.homepage          as provider_homepage,
  s.score_id,
  s.score,
  s.confidence,
  s.tier,
  s.dimensions,
  s.computed_at       as score_computed_at,
  s.engine_version
from endpoints e
join providers p     on p.id = e.provider_id
left join scores_current s on s.endpoint_id = e.id
where e.active = true;
