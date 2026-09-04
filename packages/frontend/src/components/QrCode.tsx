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
  const rad = Math.min(r, w / 2, h / 2);
  if (typeof (ctx as any).roundRect === 'function') { (ctx as any).roundRect(x, y, w, h, rad); return; }
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
}

// Brand palette. Modules stay DARK (high contrast on white) so the code always scans; the
// creativity is in the shapes and the burnt-orange finder "eyes", which echo the Sumeru flame.
const MODULE_TOP = '#2b1630';    // warm near-black at the top…
const MODULE_BOTTOM = '#0e0b16'; // …fading to a cool near-black — a subtle ember gradient
const EYE_COLOR = '#a8480c';     // deep burnt orange (~6:1 on white — clearly branded, still scans)
const BG = '#ffffff';

/** Is module (r,c) part of one of the three finder patterns (the 7×7 corner squares)? */
function inFinder(r: number, c: number, size: number): boolean {
  const inTL = r < 7 && c < 7;
  const inTR = r < 7 && c >= size - 7;
  const inBL = r >= size - 7 && c < 7;
  return inTL || inTR || inBL;
}

/**
 * A branded, "designed" QR code — rounded dot modules, custom rounded finder eyes in the brand's
 * burnt orange, a subtle dark ember gradient, and the Sumeru flame anchored in the centre. Drawn by
 * hand from the QR matrix (not the library's plain renderer) so the styling is ours.
 *
 * Encoded at error-correction level H (~30% recoverable), which is what keeps it scannable despite
 * the centre logo and the dot styling. Always dark-on-white on its own white card so it reads in any
 * app theme — a themed (e.g. low-contrast) QR does not scan.
 */
export const QrCode: React.FC<QrCodeProps> = ({ value, size = 220, logoSrc = '/sumeru-logo@2x.png' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    let qr: ReturnType<typeof QRCode.create>;
    try {
      qr = QRCode.create(value, { errorCorrectionLevel: 'H' });
    } catch {
      setError(true);
      return;
    }

    const matrix = qr.modules;
    const count = matrix.size;
    const quiet = 4;                                   // quiet zone in modules (spec minimum)
    const total = count + quiet * 2;
    const cell = Math.max(1, Math.floor(size / total));
    const dim = cell * total;                          // snap to whole cells to avoid blur
    const off = quiet * cell;
    const get = (r: number, c: number): boolean =>
      (typeof (matrix as any).get === 'function' ? !!(matrix as any).get(r, c) : !!(matrix as any).data[r * count + c]);

    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setError(true); return; }

    // Background.
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, dim, dim);

    // Module gradient (top → bottom ember).
    const grad = ctx.createLinearGradient(0, off, 0, off + count * cell);
    grad.addColorStop(0, MODULE_TOP);
    grad.addColorStop(1, MODULE_BOTTOM);

    // Data + timing modules as rounded dots (skip the finder regions — drawn as eyes below).
    ctx.fillStyle = grad;
    const rDot = cell * 0.46;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!get(r, c) || inFinder(r, c, count)) continue;
        const cx = off + c * cell + cell / 2;
        const cy = off + r * cell + cell / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, rDot, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Three finder "eyes": a rounded ring + a rounded centre dot, in brand orange.
    const drawEye = (mr: number, mc: number) => {
      const x = off + mc * cell;
      const y = off + mr * cell;
      ctx.fillStyle = EYE_COLOR;
      ctx.beginPath();
      roundRect(ctx, x, y, 7 * cell, 7 * cell, 2 * cell);            // outer rounded square
      ctx.fill();
      ctx.fillStyle = BG;
      ctx.beginPath();
      roundRect(ctx, x + cell, y + cell, 5 * cell, 5 * cell, 1.6 * cell); // punch the ring
      ctx.fill();
      ctx.fillStyle = EYE_COLOR;
      ctx.beginPath();
      roundRect(ctx, x + 2 * cell, y + 2 * cell, 3 * cell, 3 * cell, cell); // centre dot
      ctx.fill();
    };
    drawEye(0, 0);
    drawEye(0, count - 7);
    drawEye(count - 7, 0);

    // Centre logo on a white pad sized to hug it (aspect-correct — the mark is wider than tall).
    if (logoSrc) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const maxW = dim * 0.24;
        const maxH = dim * 0.24;
        const ar = (img.naturalWidth || 104) / (img.naturalHeight || 80);
        let dw = maxW, dh = maxW / ar;
        if (dh > maxH) { dh = maxH; dw = maxH * ar; }
        const pad = Math.max(5, Math.round(Math.min(dw, dh) * 0.22));
        const boxW = dw + pad * 2;
        const boxH = dh + pad * 2;
        const bx = Math.round((dim - boxW) / 2);
        const by = Math.round((dim - boxH) / 2);
        ctx.save();
        ctx.beginPath();
        roundRect(ctx, bx, by, boxW, boxH, Math.round(Math.min(boxW, boxH) * 0.3));
        ctx.fillStyle = BG;
        ctx.fill();
        ctx.drawImage(img, Math.round(bx + pad), Math.round(by + pad), Math.round(dw), Math.round(dh));
        ctx.restore();
      };
      img.onerror = () => { /* logo optional — the code still scans without it */ };
      img.src = logoSrc;
    }

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
    <div style={{ display: 'inline-block', padding: 12, background: BG, borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block' }}
        role="img"
        aria-label="Authenticator setup QR code"
      />
    </div>
  );
};

export default QrCode;
