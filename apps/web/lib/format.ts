export function formatPrice(amountUsd: number | null | undefined): string {
  if (amountUsd == null) return '—';
  if (amountUsd === 0) return 'free';
  if (amountUsd < 0.01) return `$${amountUsd.toFixed(4)}`;
  if (amountUsd < 1) return `$${amountUsd.toFixed(3)}`;
  return `$${amountUsd.toFixed(2)}`;
}

export function priceBand(amountUsd: number | null | undefined): string {
  if (amountUsd == null) return 'unknown';
  if (amountUsd === 0) return 'free';
  if (amountUsd < 0.0005) return '< $0.0005';
  if (amountUsd < 0.005) return '< $0.005';
  if (amountUsd < 0.05) return '< $0.05';
  if (amountUsd < 0.5) return '< $0.50';
  return '≥ $0.50';
}

export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const seconds = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function tierColorClass(tier: string | null | undefined): string {
  switch (tier) {
    case 'S': return 'text-yellow-400 border-yellow-500/40';
    case 'A': return 'text-green-400 border-green-500/40';
    case 'B': return 'text-sky-400 border-sky-500/40';
    case 'C': return 'text-amber-400 border-amber-500/40';
    case 'D': return 'text-orange-400 border-orange-500/40';
    case 'F': return 'text-red-500 border-red-500/40';
    case 'PROVISIONAL': return 'text-white/40 border-white/20';
    default: return 'text-white/30 border-white/10';
  }
}
