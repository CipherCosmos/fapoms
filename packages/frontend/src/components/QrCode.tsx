import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  /** The data to encode (here, an otpauth:// URI). */
  value: string;
  /** Rendered pixel size (square). */
  size?: number;
  /** Optional centre logo. Defaults to the Sumeru mark, set on a dark glowing chip. */
  logoSrc?: string;
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  if (typeof (ctx as any).roundRect === 'function') { ctx.beginPath(); (ctx as any).roundRect(x, y, w, h, rad); return; }
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

const GLOW = 'rgba(249,150,32,0.55)';

function inFinder(r: number, c: number, size: number): boolean {
  return (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
}

/**
 * A 3-D "futuristic" MFA QR: glowing, bevelled amber tiles raised off a dark glass panel, with
 * raised finder eyes and a faint screen gloss — an ember/circuit look on-brand with the flame.
 *
 * It is an INVERTED code (light modules on a dark ground). That still scans on modern cameras, but
 * to keep it dependable the tiles are kept bright and distinct and the code is error-correction
 * level H; the caller (MfaPanel) also shows the manual key. Every render is drawn by hand from the
 * QR matrix so the styling is ours.
 */
export const QrCode: React.FC<QrCodeProps> = ({ value, size = 220, logoSrc = '/sumeru-logo@2x.png' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    let qr: ReturnType<typeof QRCode.create>;
    try { qr = QRCode.create(value, { errorCorrectionLevel: 'H' }); }
    catch { setError(true); return; }

    const matrix = qr.modules;
    const count = matrix.size;
    const quiet = 4;
    const total = count + quiet * 2;
    const cell = Math.max(1, Math.floor(size / total));
    const dim = cell * total;
    const off = quiet * cell;
    const get = (r: number, c: number): boolean =>
      (typeof (matrix as any).get === 'function' ? !!(matrix as any).get(r, c) : !!(matrix as any).data[r * count + c]);

    canvas.width = dim;
    canvas.height = dim;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setError(true); return; }

    // --- Dark glass panel (the quiet zone / ground) ---
    const bg = ctx.createRadialGradient(dim / 2, dim * 0.4, dim * 0.1, dim / 2, dim / 2, dim * 0.75);
    bg.addColorStop(0, '#171326');
    bg.addColorStop(1, '#06050c');
    roundRectPath(ctx, 0, 0, dim, dim, Math.round(dim * 0.06));
    ctx.fillStyle = bg;
    ctx.fill();

    // A convex, glowing amber tile — the 3-D module.
    const tile = (px: number, py: number, s: number, bright = false) => {
      const g = ctx.createLinearGradient(px, py, px, py + s);
      g.addColorStop(0, bright ? '#FFF1D6' : '#FFE0A8');
      g.addColorStop(0.5, bright ? '#FDBA5A' : '#F8A93A');
      g.addColorStop(1, bright ? '#E67612' : '#D9600F');
      ctx.save();
      ctx.shadowColor = GLOW;
      ctx.shadowBlur = cell * (bright ? 0.7 : 0.42);
      roundRectPath(ctx, px, py, s, s, s * 0.28);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      // top highlight sliver → light catching a raised surface
      ctx.save();
      roundRectPath(ctx, px + s * 0.14, py + s * 0.10, s * 0.72, s * 0.34, s * 0.2);
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.fill();
      ctx.restore();
    };

    // Data / timing modules (skip finders — drawn as raised eyes below).
    const tsize = cell * 0.84;
    const tpad = (cell - tsize) / 2;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!get(r, c) || inFinder(r, c, count)) continue;
        tile(off + c * cell + tpad, off + r * cell + tpad, tsize);
      }
    }

    // Raised finder eyes: a glowing ring + a bright centre pip.
    const drawEye = (mr: number, mc: number) => {
      const x = off + mc * cell;
      const y = off + mr * cell;
      ctx.save();
      ctx.shadowColor = GLOW; ctx.shadowBlur = cell * 0.9;
      const ring = ctx.createLinearGradient(x, y, x, y + 7 * cell);
      ring.addColorStop(0, '#FFE9BE'); ring.addColorStop(1, '#E67612');
      roundRectPath(ctx, x + cell * 0.1, y + cell * 0.1, 7 * cell - cell * 0.2, 7 * cell - cell * 0.2, 2 * cell);
      ctx.fillStyle = ring; ctx.fill();
      ctx.restore();
      // knock out the ring centre back to the panel
      const hole = ctx.createRadialGradient(x + 3.5 * cell, y + 3 * cell, cell * 0.5, x + 3.5 * cell, y + 3.5 * cell, 3 * cell);
      hole.addColorStop(0, '#12101f'); hole.addColorStop(1, '#08060f');
      roundRectPath(ctx, x + cell, y + cell, 5 * cell, 5 * cell, 1.5 * cell);
      ctx.fillStyle = hole; ctx.fill();
      // bright centre pip (3-D)
      tile(x + 2 * cell + cell * 0.08, y + 2 * cell + cell * 0.08, 3 * cell - cell * 0.16, true);
    };
    drawEye(0, 0);
    drawEye(0, count - 7);
    drawEye(count - 7, 0);

    // Faint diagonal screen gloss.
    ctx.save();
    const gloss = ctx.createLinearGradient(0, 0, dim, dim * 0.6);
    gloss.addColorStop(0, 'rgba(255,255,255,0.06)');
    gloss.addColorStop(0.4, 'rgba(255,255,255,0)');
    roundRectPath(ctx, 0, 0, dim, dim, Math.round(dim * 0.06));
    ctx.fillStyle = gloss; ctx.fill();
    ctx.restore();

    // Centre logo on a dark glowing chip.
    if (logoSrc) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const maxW = dim * 0.2, maxH = dim * 0.2;
        const ar = (img.naturalWidth || 104) / (img.naturalHeight || 80);
        let dw = maxW, dh = maxW / ar;
        if (dh > maxH) { dh = maxH; dw = maxH * ar; }
        const pad = Math.max(6, Math.round(Math.min(dw, dh) * 0.4));
        const boxW = dw + pad * 2, boxH = dh + pad * 2;
        const bx = Math.round((dim - boxW) / 2), by = Math.round((dim - boxH) / 2);
        ctx.save();
        ctx.shadowColor = GLOW; ctx.shadowBlur = cell * 1.1;
        roundRectPath(ctx, bx, by, boxW, boxH, Math.round(Math.min(boxW, boxH) * 0.32));
        const chip = ctx.createLinearGradient(bx, by, bx, by + boxH);
        chip.addColorStop(0, '#1c1730'); chip.addColorStop(1, '#0b0916');
        ctx.fillStyle = chip; ctx.fill();
        ctx.restore();
        ctx.drawImage(img, Math.round(bx + pad), Math.round(by + pad), Math.round(dw), Math.round(dh));
      };
      img.onerror = () => {};
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
    <div style={{
      display: 'inline-block', padding: 10, borderRadius: 18,
      background: 'linear-gradient(145deg,#211a38,#0a0814)',
      boxShadow: '0 6px 22px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(249,150,32,0.25)',
    }}>
      <canvas
        ref={canvasRef}
        style={{ width: size, height: size, display: 'block', borderRadius: 12 }}
        role="img"
        aria-label="Authenticator setup QR code"
      />
    </div>
  );
};

export default QrCode;
