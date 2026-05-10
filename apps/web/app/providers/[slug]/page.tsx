import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabasePublic } from '@/lib/supabase';
import { tierColorClass, formatPrice, formatRelative } from '@/lib/format';

export const revalidate = 60;

export default async function ProviderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const sb = supabasePublic();

  const { data: provider, error } = await sb
    .from('providers')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) {
    return <div className="text-red-400">Error: {error.message}</div>;
  }
  if (!provider) notFound();

  const { data: endpoints } = await sb
    .from('discover_view')
    .select('*')
    .eq('provider_id', provider.id)
    .order('score', { ascending: false });

  const eps = endpoints ?? [];
  const scoredEps = eps.filter((e: any) => e.score != null);
  const avgScore = scoredEps.length
    ? scoredEps.reduce((a: number, e: any) => a + Number(e.score), 0) / scoredEps.length
    : null;
  const avgConf = scoredEps.length
    ? scoredEps.reduce((a: number, e: any) => a + Number(e.confidence ?? 0), 0) /
      scoredEps.length
    : null;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-white/40">Provider</div>
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="text-3xl font-bold">{provider.name}</h1>
          {provider.claimed ? (
            <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/30 text-green-400">
              claimed
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/50">
              unclaimed
            </span>
          )}
        </div>
        {provider.description ? (
          <p className="text-white/70 max-w-2xl">{provider.description}</p>
        ) : null}
        {provider.homepage ? (
          <a
            href={provider.homepage}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-sky-400 hover:text-sky-300"
          >
            {provider.homepage} ↗
          </a>
        ) : null}
        {provider.categories?.length ? (
          <div className="flex gap-1.5 flex-wrap pt-2">
            {(provider.categories as string[]).map((c) => (
              <Link
                key={c}
                href={`/discover?category=${encodeURIComponent(c)}`}
                className="text-xs px-2 py-0.5 rounded-full bg-white/5 border border-white/10 hover:border-sky-500/40"
              >
                {c}
              </Link>
            ))}
          </div>
        ) : null}
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Endpoints" value={String(eps.length)} />
        <Stat
          label="Avg score"
          value={avgScore != null ? avgScore.toFixed(1) : '—'}
        />
        <Stat
          label="Avg confidence"
          value={avgConf != null ? avgConf.toFixed(2) : '—'}
        />
        <Stat label="First seen" value={formatRelative(provider.created_at)} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Endpoints</h2>
        {eps.length === 0 ? (
          <div className="text-white/50 text-sm">No active endpoints.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-white/50 border-b border-white/10">
              <tr>
                <th className="py-2">Endpoint</th>
                <th className="py-2">Capabilities</th>
                <th className="py-2 text-right">Price</th>
                <th className="py-2 text-right">Score</th>
                <th className="py-2 text-right">Conf.</th>
                <th className="py-2 text-right">Last probed</th>
                <th className="py-2 text-center">Tier</th>
              </tr>
            </thead>
            <tbody>
              {eps.map((e: any) => (
                <tr key={e.endpoint_id} className="border-b border-white/5">
                  <td className="py-2 truncate max-w-[260px]" title={e.url}>
                    <span className="text-white/40">{e.method}</span> {e.url}
                  </td>
                  <td className="py-2 text-white/70">
                    {(e.capabilities ?? []).slice(0, 3).join(', ')}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatPrice(e.pricing?.amount_usd)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {e.score != null ? Number(e.score).toFixed(1) : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums text-white/60">
                    {e.confidence != null ? Number(e.confidence).toFixed(2) : '—'}
                  </td>
                  <td className="py-2 text-right text-white/50 text-xs">
                    {formatRelative(e.last_probe_ts)}
                  </td>
                  <td
                    className={`py-2 text-center font-bold ${tierColorClass(e.tier)}`}
                  >
                    {e.tier ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/10 rounded p-3">
      <div className="text-xs text-white/50">{label}</div>
      <div className="text-lg tabular-nums">{value}</div>
    </div>
  );
}
