import { ENGINE_VERSION } from '@payradar/scoring-engine';

export const runtime = 'nodejs';

// Surfaces the bits an uptime monitor or status page wants to see.
// Intentionally cheap — no DB roundtrip — so it can be polled aggressively.
export async function GET() {
  return Response.json(
    {
      ok: true,
      service: 'payradar-web',
      engine_version: ENGINE_VERSION,
      ts: new Date().toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}
