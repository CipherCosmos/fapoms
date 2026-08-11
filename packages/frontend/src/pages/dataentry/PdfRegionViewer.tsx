import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Crop, X, Loader2 } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
// The worker is bundled from the installed pdfjs-dist, not fetched from a CDN at runtime.
// This tool renders bank-collateral audit PDFs, often inside locked-down or air-gapped bank
// networks where unpkg.com is unreachable or blocked by CSP — a runtime CDN fetch meant the
// viewer, and the whole case workspace, silently failed to render. `?url` makes Vite emit the
// worker as a hashed asset served from our own origin, version-locked to the installed package.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * The returned audit packet, with a marking tool.
 *
 * The data entry desk's questions are almost always about a specific place on a
 * specific page — "this gross weight, third row". Describing that in prose is slow
 * and error-prone, so this lets them drag a box over the page, which is cropped
 * straight off the render canvas and handed to the chat as an image plus a
 * durable anchor.
 *
 * Regions are reported normalised (0..1) against the page box rather than in
 * pixels, so a mark made at one zoom still points at the right place at another,
 * and still resolves months later on a different screen.
 */

export interface Region { x: number; y: number; w: number; h: number }

export interface RegionCapture {
  pageNumber: number;
  region: Region;
  /** PNG crop of the marked area, ready to upload. */
  blob: Blob;
  dataUrl: string;
}

interface Props {
  /** Signed, short-lived URL for the PDF bytes. */
  fileUrl: string;
  /** Jump here when the user clicks an anchored message. */
  focus?: { pageNumber: number; region: Region | null } | null;
  onCapture: (c: RegionCapture) => void;
}

export const PdfRegionViewer: React.FC<Props> = ({ fileUrl, focus, onCapture }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<any>(null);
  const renderTaskRef = useRef<any>(null);

  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.3);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [marking, setMarking] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  /** Rectangle to draw over the page — either a live drag or an incoming focus. */
  const [highlight, setHighlight] = useState<Region | null>(null);

  // ── Load ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    pdfjs.getDocument({ url: fileUrl }).promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current = doc;
        setPages(doc.numPages);
        setPage(1);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Could not open this PDF: ${e?.message ?? e}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      docRef.current?.destroy?.();
      docRef.current = null;
    };
  }, [fileUrl]);

  // ── Render the current page ─────────────────────────────────────────────
  const render = useCallback(async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || page < 1 || page > doc.numPages) return;

    // Cancel any in-flight render: page-flipping faster than rendering otherwise
    // throws "canvas already in use".
    renderTaskRef.current?.cancel?.();

    const pdfPage = await doc.getPage(page);
    const viewport = pdfPage.getViewport({ scale });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Render at device resolution so crops are legible rather than blurry.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const task = pdfPage.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = task;
    try {
      await task.promise;
    } catch (e: any) {
      if (e?.name !== 'RenderingCancelledException') throw e;
    }
  }, [page, scale]);

  useEffect(() => { render(); }, [render]);

  // ── Follow an anchored message ──────────────────────────────────────────
  useEffect(() => {
    if (!focus) return;
    setPage(focus.pageNumber);
    setHighlight(focus.region);
    // Leave the highlight up long enough to be seen, then clear it so it does not
    // sit permanently over the page.
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [focus]);

  // ── Marking ─────────────────────────────────────────────────────────────
  const localPoint = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(e.clientY - rect.top, 0), rect.height),
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!marking) return;
    const p = localPoint(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!marking || !drag) return;
    const p = localPoint(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };

  const onMouseUp = async () => {
    if (!marking || !drag) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    setDrag(null);

    // A click rather than a drag — nothing to capture.
    if (w < 8 || h < 8) return;

    const dpr = window.devicePixelRatio || 1;
    const crop = document.createElement('canvas');
    crop.width = Math.round(w * dpr);
    crop.height = Math.round(h * dpr);
    const ctx = crop.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      canvas,
      Math.round(x * dpr), Math.round(y * dpr), Math.round(w * dpr), Math.round(h * dpr),
      0, 0, crop.width, crop.height,
    );

    const region: Region = {
      x: +(x / rect.width).toFixed(4),
      y: +(y / rect.height).toFixed(4),
      w: +(w / rect.width).toFixed(4),
      h: +(h / rect.height).toFixed(4),
    };

    crop.toBlob((blob) => {
      if (!blob) return;
      onCapture({ pageNumber: page, region, blob, dataUrl: crop.toDataURL('image/png') });
      setMarking(false);
    }, 'image/png');
  };

  const overlay = (() => {
    if (drag) {
      return {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
        tone: 'var(--accent)',
      };
    }
    if (highlight && canvasRef.current) {
      const r = canvasRef.current.getBoundingClientRect();
      return {
        left: highlight.x * r.width,
        top: highlight.y * r.height,
        width: highlight.w * r.width,
        height: highlight.h * r.height,
        tone: 'var(--warning)',
      };
    }
    return null;
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', flexWrap: 'wrap',
        borderBottom: '1px solid var(--border-color)',
      }}>
        <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
          className="btn btn-secondary" style={btn}><ChevronLeft size={14} /></button>
        <span style={{ fontSize: '12px', whiteSpace: 'nowrap' }}>
          <input
            type="number" value={page} min={1} max={pages || 1}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (n >= 1 && n <= pages) setPage(n);
            }}
            style={{
              width: '46px', padding: '3px 5px', fontSize: '12px', textAlign: 'center',
              background: 'var(--bg-input)', color: 'inherit',
              border: '1px solid var(--border-color)', borderRadius: '5px',
            }}
          /> / {pages || '—'}
        </span>
        <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page >= pages}
          className="btn btn-secondary" style={btn}><ChevronRight size={14} /></button>

        <span style={{ width: '1px', height: '18px', background: 'var(--border-color)' }} />

        <button onClick={() => setScale((s) => Math.max(0.5, +(s - 0.2).toFixed(2)))} className="btn btn-secondary" style={btn}><ZoomOut size={14} /></button>
        <span style={{ fontSize: '11.5px', minWidth: '38px', textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button onClick={() => setScale((s) => Math.min(3, +(s + 0.2).toFixed(2)))} className="btn btn-secondary" style={btn}><ZoomIn size={14} /></button>

        <button
          onClick={() => { setMarking((m) => !m); setDrag(null); }}
          className={marking ? 'btn btn-primary' : 'btn btn-secondary'}
          style={{ ...btn, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px' }}
        >
          {marking ? <><X size={13} /> Cancel</> : <><Crop size={13} /> Mark an area</>}
        </button>
      </div>

      {marking && (
        <div style={{ padding: '6px 10px', fontSize: '11.5px', background: 'var(--status-active-bg)', color: 'var(--accent)' }}>
          Drag a box around the detail you want to ask about — it is captured and attached to your message.
        </div>
      )}

      <div ref={wrapRef} style={{ flex: 1, overflow: 'auto', background: 'var(--bg-page)', padding: '14px', minHeight: 0 }}>
        {loading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', fontSize: '13px' }}>
            <Loader2 size={15} className="spin" /> Loading document…
          </div>
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: '13px' }}>{error}</div>}
        <div
          style={{ position: 'relative', display: 'inline-block', cursor: marking ? 'crosshair' : 'default' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => setDrag(null)}
        >
          <canvas ref={canvasRef} style={{ display: loading || error ? 'none' : 'block', borderRadius: '4px' }} />
          {overlay && (
            <div style={{
              position: 'absolute', pointerEvents: 'none',
              left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height,
              border: `2px solid ${overlay.tone}`, background: 'var(--status-pending-bg)', borderRadius: '2px',
            }} />
          )}
        </div>
      </div>
    </div>
  );
};

const btn: React.CSSProperties = { padding: '4px 8px', fontSize: '12px' };

export default PdfRegionViewer;
