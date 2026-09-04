import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface QrCodeProps {
  /** The data to encode (here, an otpauth:// URI). */
  value: string;
  /** Rendered pixel size of the scannable code (the flame badge around it is larger). */
  size?: number;
  /**
   * Optional centre logo. Off by default here because the whole badge is already the flame — a
   * second flame in the middle of the code is redundant. Pass a path to force one.
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

const MODULE_TOP = '#2b1630';
const MODULE_BOTTOM = '#0e0b16';
const EYE_COLOR = '#a8480c';
const BG = '#ffffff';

function inFinder(r: number, c: number, size: number): boolean {
  return (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7);
}

/**
 * Trace a flame silhouette (tip up) inside the box (x,y,w,h). Approximate but reads clearly as the
 * Sumeru mark: a pointed top, a broad rounded body, a small notch at the base.
 */
function flamePath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const cx = x + w / 2;
  ctx.beginPath();
  ctx.moveTo(cx, y);                                                            // tip
  ctx.bezierCurveTo(x + w * 0.12, y + h * 0.20, x + w * 1.02, y + h * 0.28, x + w * 0.88, y + h * 0.60); // right shoulder bulge
  ctx.bezierCurveTo(x + w * 1.00, y + h * 0.88, x + w * 0.66, y + h * 1.02, cx, y + h * 0.90);          // to rounded base (right)
  ctx.bezierCurveTo(x + w * 0.34, y + h * 1.02, x, y + h * 0.88, x + w * 0.12, y + h * 0.60);            // base (left) up
  ctx.bezierCurveTo(x - w * 0.02, y + h * 0.28, x + w * 0.88, y + h * 0.20, cx, y);                      // left shoulder to tip
  ctx.closePath();
}

/**
 * A branded MFA QR presented as the Sumeru flame: the scannable code (rounded dot modules + orange
 * finder eyes, error-correction level H) sits inside a flame-shaped badge, so the overall graphic is
 * the icon rather than a plain square. The code itself stays square and high-contrast on white —
 * that is a hard requirement of the QR format, so only the SURROUND takes the flame shape.
 */
export const QrCode: React.FC<QrCodeProps> = ({ value, size = 200, logoSrc }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    let qr: ReturnType<typeof QRCode.create>;
    try {
      qr = QRCode.create(value, { errorCorrectionLevel: 'H' });
    } catch { setError(true); return; }

    const matrix = qr.modules;
    const count = matrix.size;
    const quiet = 4;
    const total = count + quiet * 2;
    const cell = Math.max(1, Math.floor(size / total));
    const codeDim = cell * total;              // the white QR panel (square, scannable)
    const off = quiet * cell;
    const get = (r: number, c: number): boolean =>
      (typeof (matrix as any).get === 'function' ? !!(matrix as any).get(r, c) : !!(matrix as any).data[r * count + c]);

    // Flame badge geometry: taller than wide, code seated in the lower body, tip rising above.
    const flameW = Math.round(codeDim * 1.62);
    const flameH = Math.round(codeDim * 2.0);
    const panelX = Math.round((flameW - codeDim) / 2);
    const panelY = Math.round(flameH - codeDim - codeDim * 0.14);

    canvas.width = flameW;
    canvas.height = flameH;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setError(true); return; }
    ctx.clearRect(0, 0, flameW, flameH);

    // --- Flame silhouette ---
    const fg = ctx.createLinearGradient(0, 0, 0, flameH);
    fg.addColorStop(0.00, '#FDBA74');
    fg.addColorStop(0.35, '#F97316');
    fg.addColorStop(0.72, '#EA580C');
    fg.addColorStop(1.00, '#C2410C');
    ctx.save();
    ctx.shadowColor = 'rgba(234,88,12,0.35)';
    ctx.shadowBlur = Math.round(codeDim * 0.06);
    ctx.shadowOffsetY = 2;
    flamePath(ctx, 2, 2, flameW - 4, flameH - 4);
    ctx.fillStyle = fg;
    ctx.fill();
    ctx.restore();

    // --- White code panel seated in the flame body ---
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, panelX, panelY, codeDim, codeDim, Math.round(codeDim * 0.10));
    ctx.fillStyle = BG;
    ctx.fill();
    ctx.restore();

    // --- The scannable code, drawn into the panel ---
    const ox = panelX + off;
    const oy = panelY + off;
    const grad = ctx.createLinearGradient(0, oy, 0, oy + count * cell);
    grad.addColorStop(0, MODULE_TOP);
    grad.addColorStop(1, MODULE_BOTTOM);
    ctx.fillStyle = grad;
    const rDot = cell * 0.46;
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!get(r, c) || inFinder(r, c, count)) continue;
        ctx.beginPath();
        ctx.arc(ox + c * cell + cell / 2, oy + r * cell + cell / 2, rDot, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const drawEye = (mr: number, mc: number) => {
      const x = ox + mc * cell;
      const y = oy + mr * cell;
      ctx.fillStyle = EYE_COLOR;
      ctx.beginPath(); roundRect(ctx, x, y, 7 * cell, 7 * cell, 2 * cell); ctx.fill();
      ctx.fillStyle = BG;
      ctx.beginPath(); roundRect(ctx, x + cell, y + cell, 5 * cell, 5 * cell, 1.6 * cell); ctx.fill();
      ctx.fillStyle = EYE_COLOR;
      ctx.beginPath(); roundRect(ctx, x + 2 * cell, y + 2 * cell, 3 * cell, 3 * cell, cell); ctx.fill();
    };
    drawEye(0, 0);
    drawEye(0, count - 7);
    drawEye(count - 7, 0);

    // Optional centre logo (off by default — the badge is already the flame).
    if (logoSrc) {
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        const maxW = codeDim * 0.22, maxH = codeDim * 0.22;
        const ar = (img.naturalWidth || 104) / (img.naturalHeight || 80);
        let dw = maxW, dh = maxW / ar;
        if (dh > maxH) { dh = maxH; dw = maxH * ar; }
        const pad = Math.max(5, Math.round(Math.min(dw, dh) * 0.22));
        const boxW = dw + pad * 2, boxH = dh + pad * 2;
        const bx = Math.round(panelX + (codeDim - boxW) / 2);
        const by = Math.round(panelY + (codeDim - boxH) / 2);
        ctx.save();
        ctx.beginPath(); roundRect(ctx, bx, by, boxW, boxH, Math.round(Math.min(boxW, boxH) * 0.3));
        ctx.fillStyle = BG; ctx.fill();
        ctx.drawImage(img, Math.round(bx + pad), Math.round(by + pad), Math.round(dw), Math.round(dh));
        ctx.restore();
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
    <canvas
      ref={canvasRef}
      style={{ height: Math.round(size * 2.0), width: 'auto', display: 'block' }}
      role="img"
      aria-label="Authenticator setup QR code"
    />
  );
};

export default QrCode;
