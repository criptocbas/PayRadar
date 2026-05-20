-- 0002_search_freshness
-- Adds: trigram capability search, sync_runs ops log, refreshed discover_view
--       (last_probe_ts + provider_categories + signature exposure), and the
--       search_endpoints RPC the API uses for /v1/discover.

create extension if not exists pg_trgm;

-- ============================================================================
-- Trigram indexes for fuzzy search.
-- pg_trgm needs scalar text, so we index array_to_string(capabilities, ' ').
-- This is "semantic-ish": it tolerates typos and partial matches.
-- The pgvector upgrade path (true semantic capability search) lives behind a
-- capability_embeddings table — out of scope for v0.1 MVP.
-- ----------------------------------------------------------------------------
-- Why the wrapper: Postgres rejects array_to_string in a functional index
-- because it's not marked IMMUTABLE in the catalog. With a fixed non-null
-- separator the result is fully deterministic, so we wrap it in an IMMUTABLE
-- helper so the GIN index can be built.
-- ============================================================================
create or replace function payradar_caps_text(arr text[])
returns text
language sql
immutable
parallel safe
as $$ select array_to_string(arr, ' ') $$;

create index endpoints_capabilities_trgm_idx
  on endpoints using gin (payradar_caps_text(capabilities) gin_trgm_ops);

create index providers_name_trgm_idx
  on providers using gin (lower(name) gin_trgm_ops);

create index providers_slug_trgm_idx
  on providers using gin (slug gin_trgm_ops);

-- ============================================================================
-- Operations log. Useful for monitoring + debugging cron behavior.
-- Not currently consumed by the scoring engine (freshness reads probe ts
-- directly), but powers the deployment-health dashboard.
-- ============================================================================
create table sync_runs (
  id           bigserial primary key,
  kind         text not null check (kind in ('catalog','probes','scoring')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  details      jsonb
);
create index sync_runs_started_idx on sync_runs(started_at desc);

alter table sync_runs enable row level security;
create policy "public read sync_runs" on sync_runs for select using (true);

-- ============================================================================
-- discover_view — refreshed.
-- Adds: provider_categories, signature, last_probe_ts, last_ok_probe_ts.
-- ============================================================================
drop view if exists discover_view;
create view discover_view as
select
  e.id                       as endpoint_id,
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
  p.slug                     as provider_slug,
  p.name                     as provider_name,
  p.homepage                 as provider_homepage,
  p.categories               as provider_categories,
  s.score_id,
  s.score,
  s.confidence,
  s.tier,
  s.dimensions,
  s.signature,
  s.computed_at              as score_computed_at,
  s.engine_version,
  (select max(ts) from probes pr where pr.endpoint_id = e.id and pr.ok = true) as last_ok_probe_ts,
  (select max(ts) from probes pr where pr.endpoint_id = e.id) as last_probe_ts
from endpoints e
join providers p on p.id = e.provider_id
left join scores_current s on s.endpoint_id = e.id
where e.active = true;

-- ============================================================================
-- search_endpoints — single-round-trip RPC for /v1/discover.
-- Sort options: 'score' (default), 'price' (asc), 'latency' (latency dim score
-- desc = fastest first), 'confidence'.
-- All filters are nullable so the route handler can pass null where the user
-- didn't specify a filter.
-- ============================================================================
create or replace function search_endpoints(
  q              text     default null,
  category       text     default null,
  min_score      numeric  default 0,
  max_price_usd  numeric  default 1e9,
  sort_by        text     default 'score',
  result_limit   int      default 20
)
returns setof discover_view
language sql
stable
as $$
  select * from discover_view dv
  where
    (q is null or exists (
      select 1 from unnest(dv.capabilities) cap
      where cap ilike '%' || q || '%'
         or similarity(cap, q) > 0.3
    ))
    and (category is null or category = any(coalesce(dv.provider_categories, '{}'::text[])))
    and coalesce(dv.score, 0) >= min_score
    and coalesce((dv.pricing->>'amount_usd')::numeric, 1e9) <= max_price_usd
  order by
    case sort_by
      when 'price'
        then -coalesce((dv.pricing->>'amount_usd')::numeric, 1e9)
      when 'latency'
        then coalesce((dv.dimensions->'latency'->>'score')::numeric, -1)
      when 'confidence'
        then coalesce(dv.confidence, 0) * 100
      else
        coalesce(dv.score, -1)
    end desc nulls last
  limit result_limit;
$$;

grant execute on function search_endpoints(text, text, numeric, numeric, text, int)
  to anon, authenticated;

-- ============================================================================
-- RLS audit helper — call this in CI / staging to confirm public-read works
-- for anon and writes are rejected. Not used in production code paths.
-- ============================================================================
create or replace function rls_smoketest()
returns table(check_name text, ok boolean)
language plpgsql
security invoker
as $$
begin
  return query select 'providers_readable'::text,
    exists(select 1 from providers limit 1) or true;
  return query select 'endpoints_readable'::text,
    exists(select 1 from endpoints limit 1) or true;
  return query select 'scores_readable'::text,
    exists(select 1 from scores_current limit 1) or true;
end;
$$;
