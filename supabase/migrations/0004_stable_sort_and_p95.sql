-- 0004_stable_sort_and_p95
--
-- Two cosmetic-but-load-bearing fixes surfaced during the launch-readiness
-- review of /discover:
--
--   1. Expose real latency in milliseconds (latency_p95_ms) alongside the
--      latency dimension score. The UI was rendering "Latency: 100" using the
--      0-100 dimension score, which reads as "100 ms" — exactly inverted from
--      reality (100 is fastest). Computing the real p95 from the most recent
--      successful probes is honest and what an agent actually wants to filter
--      on.
--
--   2. Add deterministic tiebreakers to search_endpoints. Cold-start scores
--      cluster many endpoints at identical (score, confidence) tuples; Postgres
--      then returns them in physical-row order, which happens to group by
--      provider. First-time visitors saw 8 rows of the same provider in a row.
--      Stable secondary sort on (confidence desc, endpoint_id asc) keeps tied
--      groups deterministic without privileging any one provider.

-- search_endpoints returns `setof discover_view`, so we have to drop it
-- before the view it depends on.
drop function if exists search_endpoints(text, text, numeric, numeric, text, int);
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
  (select max(ts) from probes pr where pr.endpoint_id = e.id) as last_probe_ts,
  -- Real p95 latency in ms, from the 100 most recent successful probes.
  -- Bounded so one historical outlier doesn't dominate; not part of the signed
  -- score payload (computed at read time), so it can evolve independently of
  -- engine_version.
  (select percentile_cont(0.95) within group (order by latency_ms)
   from (
     select latency_ms
     from probes pr2
     where pr2.endpoint_id = e.id
       and pr2.ok = true
       and pr2.latency_ms is not null
     order by pr2.ts desc
     limit 100
   ) recent) as latency_p95_ms
from endpoints e
join providers p on p.id = e.provider_id
left join scores_current s on s.endpoint_id = e.id
where e.active = true;

-- search_endpoints — same filters as 0002, plus deterministic tiebreakers.
create function search_endpoints(
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
    end desc nulls last,
    -- Stable tiebreakers prevent the visually-broken effect of many rows
    -- sharing the same primary value clustering by physical insertion order.
    coalesce(dv.confidence, 0) desc,
    dv.endpoint_id asc
  limit result_limit;
$$;

grant execute on function search_endpoints(text, text, numeric, numeric, text, int)
  to anon, authenticated;
