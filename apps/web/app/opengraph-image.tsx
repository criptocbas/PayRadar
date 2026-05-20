import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'PayRadar — Trust + Discovery for pay.sh';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'linear-gradient(135deg, #020617 0%, #0c1b3a 100%)',
          padding: 72,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: 'white',
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 700,
            height: 700,
            background:
              'radial-gradient(circle, rgba(56,189,248,0.25) 0%, transparent 70%)',
            transform: 'translate(30%, -30%)',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 22,
            color: '#38bdf8',
            letterSpacing: 1,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#38bdf8',
            }}
          />
          PAYRADAR · engine 0.1.0
        </div>

        <div
          style={{
            marginTop: 56,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -2 }}>
            The Trust Layer
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 800,
              letterSpacing: -2,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            for pay.sh
          </div>
        </div>

        <div
          style={{
            marginTop: 40,
            fontSize: 30,
            color: 'rgba(255,255,255,0.78)',
            maxWidth: 920,
            lineHeight: 1.35,
          }}
        >
          Signed reliability, latency &amp; freshness scores for every pay-as-you-go
          API. Verifiable offline. Open formula. Built for agents.
        </div>

        <div
          style={{
            marginTop: 'auto',
            display: 'flex',
            gap: 18,
            fontSize: 24,
          }}
        >
          <div
            style={{
              padding: '14px 22px',
              borderRadius: 10,
              background: '#38bdf8',
              color: '#020617',
              fontWeight: 700,
            }}
          >
            pay-radar-web.vercel.app
          </div>
          <div
            style={{
              padding: '14px 22px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              color: 'rgba(255,255,255,0.7)',
            }}
          >
            ed25519 · 73 providers · 713 endpoints
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
