import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#020617',
          color: '#38bdf8',
          fontSize: 38,
          fontWeight: 800,
          letterSpacing: -2,
          borderRadius: 12,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        PR
      </div>
    ),
    { ...size }
  );
}

export const dynamic = 'force-static';
