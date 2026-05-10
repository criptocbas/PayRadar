import { NextRequest } from 'next/server';
import { syncCatalog, runProbes, runScoring } from '@payradar/ingestor';

// Vercel Cron hits this route. Cadence is configured in vercel.json.
// Long-running tasks need a longer maxDuration than the default.
export const runtime = 'nodejs';
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // Vercel Cron sends a Bearer token equal to CRON_SECRET; manual triggers
  // can use the same token.
  const auth = req.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  return !!process.env.CRON_SECRET && auth === expected;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sync = await syncCatalog();
  const probes = await runProbes();
  const scoring = await runScoring();

  return Response.json({ ok: true, sync, probes, scoring });
}
