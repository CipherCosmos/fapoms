import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  /** The data to encode (here, an otpauth:// URI). */
  value: string;
  /** Rendered pixel size (square). */
  size?: number;
  /**
   * Optional centre logo; drawn on a white pad so it never eats scannable modules. Defaults to the
   * real Sumeru mark — the same asset BrandLogo and the favicon use (`/logo.png` is a DIFFERENT
   * product's logo, "Gold Audit Pro", so it is deliberately not used here).
   */
  logoSrc?: string;
}

/** Rounded-rect path with a graceful fallback for engines without ctx.roundRect. */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  if (typeof (ctx as any).roundRect === 'function') { (ctx as any).roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

/**
 * A branded QR code. Encodes `value` at error-correction level H (~30% recoverable), which is what
 * makes a centre logo safe: the modules it covers can still be reconstructed, so the code scans. The
 * code is always dark-on-white regardless of app theme — a themed (e.g. dark-on-dark) QR does not
 * scan — and sits on its own white card so it reads in dark mode too.
 */
export const QrCode: React.FC<QrCodeProps> = ({ value, size = 208, logoSrc = '/sumeru-logo@2x.png' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    QRCode.toCanvas(canvas, value, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: size,
      color: { dark: '#0f172a', light: '#ffffff' },
    })
      .then(() => {
        if (cancelled || !logoSrc) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          // Fit the mark inside ~26% of the code PRESERVING its aspect ratio (it is a wide
          // flame+wordmark, not square), and size the white pad to hug it. ECC level H means the
          // ~26%×20% the pad covers stays recoverable, so the code still scans.
          const maxW = size * 0.26;
          const maxH = size * 0.26;
          const ar = (img.naturalWidth || 104) / (img.naturalHeight || 80);
          let dw = maxW, dh = maxW / ar;
          if (dh > maxH) { dh = maxH; dw = maxH * ar; }
          const pad = Math.max(5, Math.round(Math.min(dw, dh) * 0.22));
          const boxW = dw + pad * 2;
          const boxH = dh + pad * 2;
          const x = Math.round((canvas.width - boxW) / 2);
          const y = Math.round((canvas.height - boxH) / 2);
          ctx.save();
          ctx.beginPath();
          roundRect(ctx, x, y, boxW, boxH, Math.round(Math.min(boxW, boxH) * 0.28));
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.drawImage(img, Math.round(x + pad), Math.round(y + pad), Math.round(dw), Math.round(dh));
          ctx.restore();
        };
        img.onerror = () => { /* logo optional — a plain code still scans */ };
        img.src = logoSrc;
      })
      .catch(() => { if (!cancelled) setError(true); });

    return () => { cancelled = true; };
  }, [value, size, logoSrc]);

  if (error) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
        Couldn’t draw the QR code — use the setup key below instead.
      </div>
    );
  }

  return (
    <div style={{ display: 'inline-block', padding: 12, background: '#ffffff', borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{ width: size, height: size, display: 'block' }}
        role="img"
        aria-label="Authenticator setup QR code"
      />
    </div>
  );
};

export default QrCode;
