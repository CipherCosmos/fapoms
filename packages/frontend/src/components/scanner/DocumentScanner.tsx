import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, Check, Loader2, RotateCcw, X, Zap, ZapOff, Plus, FileText, Sun, Contrast,
} from 'lucide-react';
import {
  SCAN_SHAPE_ASPECT, scanFileName, shapeRemark, shapeVerdict,
  type DocumentScanProfile, type ScanShape,
} from '@fapoms/shared';
import {
  detectPageQuad, enhance, quadAspect, quadOutputSize, rotateQuad, toGrey, warpQuad,
  type Point, type Quad, type ScanFinish,
} from './scan-image';

/**
 * A DOCUMENT SCANNER, NOT A CAMERA BUTTON.
 *
 * Every document in this app arrived through a file picker. On a phone that picker offers the
 * camera (`capture="environment"`), and what comes back is a photograph of a card lying on a desk:
 * the desk is in it, the card is a trapezium because nobody holds a phone parallel to a table, the
 * exposure is set for the room, and it is four megabytes. A clerk then squints at it to read a PAN
 * number. That is the whole problem this replaces.
 *
 * What it does instead: finds the page in the frame, lets the corners be dragged if it found them
 * imperfectly, lifts the page out and lays it flat, cleans it up, and hands back a JPEG of the
 * document and nothing else. Several of them, if the document has several pages.
 *
 * WHAT IT NEVER DOES IS BLOCK. A camera can be absent, refused, or already held by another tab;
 * the machine can be a desktop with no camera at all; an insecure origin has no `getUserMedia` to
 * call. Every one of those ends at the same place — the file picker that was always there — with a
 * sentence saying which of them happened. `ScanOrAttach` is the control that pairs the two, and is
 * what surfaces should use rather than this component directly.
 */

type Stage = 'starting' | 'live' | 'captured' | 'refused';

interface Shot {
  /** The full-resolution frame, as drawn off the video element. */
  image: ImageData;
  /** Corners in the frame's own pixel coordinates — detected, then dragged. */
  quad: Quad;
  /** True when the corners are the frame's edges because nothing was found. */
  guessed: boolean;
  /** Said out loud when the capture is no orientation of the expected document. Never a refusal. */
  remark: string | null;
  /** True when the document was held the other way round and the scan was turned to match. */
  turned: boolean;
}

const FINISHES: Array<{ value: ScanFinish; label: string; icon: React.ReactNode; hint: string }> = [
  { value: 'photo', label: 'Colour', icon: <Sun size={14} />, hint: 'Leaves the colours alone — photographs, passbooks, anything where the colour is part of what is checked.' },
  { value: 'document', label: 'Document', icon: <FileText size={14} />, hint: 'Grey, with the contrast stretched — what a flatbed scanner gives you.' },
  { value: 'ink', label: 'High contrast', icon: <Contrast size={14} />, hint: 'Black on white, shadow-tolerant — for dense text you need to read.' },
];

/** The longest edge of an uploaded scan. Bigger reads no better and costs the candidate data. */
const MAX_OUTPUT_EDGE = 2000;
/** The detector runs on a frame this wide; full resolution buys nothing and costs a visible stall. */
const DETECT_WIDTH = 280;

export interface DocumentScannerProps {
  /** What is being scanned, shown in the header so the camera is never anonymous. */
  documentLabel: string;
  /**
   * What this particular document is — its shape, the finish to start on, whether it runs to more
   * than one page. From `scanProfileFor(requirement)` in the shared table, so a PAN card is
   * photographed as a card and a joining form as a page, rather than both as "a document".
   */
  profile: DocumentScanProfile;
  onCancel: () => void;
  onScanned: (files: File[]) => void;
}

export const DocumentScanner: React.FC<DocumentScannerProps> = ({
  documentLabel, profile, onCancel, onScanned,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const stillRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef<number | null>(null);

  const [stage, setStage] = useState<Stage>('starting');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const [finish, setFinish] = useState<ScanFinish>(profile.finish);
  const [pages, setPages] = useState<File[]>([]);
  const [torchOn, setTorchOn] = useState(false);
  const [torchable, setTorchable] = useState(false);
  const [working, setWorking] = useState(false);
  const multiPage = profile.multiPage;

  // ── The camera ────────────────────────────────────────────────────────────

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setStage('starting');
    setRefusal(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setRefusal('This browser will not give a web page the camera. Choose a photo or a PDF instead.');
      setStage('refused');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // `ideal`, never `exact`: a laptop has only a front camera, and demanding the back one
        // there fails outright instead of using the one camera the machine has.
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const capabilities = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
      setTorchable(!!capabilities.torch);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStage('live');
    } catch (e) {
      const name = (e as { name?: string })?.name ?? '';
      setRefusal(
        name === 'NotAllowedError'
          ? 'The camera is blocked for this site. Allow it in the browser address bar, or choose a photo or a PDF instead.'
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'No camera on this device. Choose a photo or a PDF instead.'
            : 'The camera could not be opened — another app may be using it. Choose a photo or a PDF instead.',
      );
      setStage('refused');
    }
  }, []);

  useEffect(() => {
    void startCamera();
    return stopCamera;
  }, [startCamera, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      // `torch` is a real constraint every mobile browser that has a flash supports, and is
      // absent from the DOM typings — hence the cast rather than a pretend type.
      await track.applyConstraints({ advanced: [{ torch: next }] } as unknown as MediaTrackConstraints);
      setTorchOn(next);
    } catch {
      setTorchable(false); // It said it could and then could not; stop offering it.
    }
  };

  // ── The live outline ──────────────────────────────────────────────────────

  /**
   * The green quadrilateral over the viewfinder, redrawn a few times a second.
   *
   * Throttled deliberately: detection is real work and running it per frame makes the preview
   * stutter on the mid-range Android phones this is actually used on, for an outline nobody can
   * follow at 60fps anyway.
   */
  useEffect(() => {
    if (stage !== 'live') return undefined;
    let live = true;
    let lastRun = 0;

    const tick = (now: number) => {
      if (!live) return;
      frameRef.current = requestAnimationFrame(tick);
      const video = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay || video.readyState < 2 || now - lastRun < 220) return;
      lastRun = now;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      overlay.width = vw;
      overlay.height = vh;
      const ctx = overlay.getContext('2d');
      if (!ctx) return;

      const scale = DETECT_WIDTH / vw;
      const sw = DETECT_WIDTH;
      const sh = Math.max(1, Math.round(vh * scale));
      const work = document.createElement('canvas');
      work.width = sw;
      work.height = sh;
      const wctx = work.getContext('2d');
      if (!wctx) return;
      wctx.drawImage(video, 0, 0, sw, sh);
      const small = wctx.getImageData(0, 0, sw, sh);
      const quad = detectPageQuad(toGrey(small.data, sw, sh), sw, sh);

      ctx.clearRect(0, 0, vw, vh);
      drawGuide(ctx, vw, vh, profile.shape);
      if (!quad) return;
      ctx.beginPath();
      quad.forEach((p, i) => {
        const x = p.x / scale;
        const y = p.y / scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = 'rgba(34,197,94,0.95)';
      ctx.lineWidth = Math.max(3, vw / 240);
      ctx.fillStyle = 'rgba(34,197,94,0.14)';
      ctx.fill();
      ctx.stroke();
    };

    frameRef.current = requestAnimationFrame(tick);
    return () => {
      live = false;
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [stage, profile.shape]);

  // ── Taking the shot ───────────────────────────────────────────────────────

  const capture = () => {
    const video = videoRef.current;
    if (!video?.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const scale = DETECT_WIDTH / canvas.width;
    const sw = DETECT_WIDTH;
    const sh = Math.max(1, Math.round(canvas.height * scale));
    const work = document.createElement('canvas');
    work.width = sw;
    work.height = sh;
    const wctx = work.getContext('2d');
    let quad: Quad | null = null;
    if (wctx) {
      wctx.drawImage(canvas, 0, 0, sw, sh);
      const small = wctx.getImageData(0, 0, sw, sh);
      const found = detectPageQuad(toGrey(small.data, sw, sh), sw, sh);
      if (found) quad = found.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad;
    }

    // Nothing found is not a dead end: the frame's own corners, inset a little, are a starting
    // point somebody can drag. It says so on screen rather than pretending it found the page.
    const inset = Math.min(canvas.width, canvas.height) * 0.06;
    const fallback: Quad = quad ?? guideQuad(canvas.width, canvas.height, profile.shape, inset);

    /*
      A card held upright in somebody's hand is a card, not a mistake. The shape it was asked for
      says which way round the finished scan should read, so when the capture matches that shape
      turned over, the corners are simply relabelled — see `rotateQuad` — and the scan comes out
      the way a card is read. Only a capture that is no orientation of the document at all gets a
      sentence, and even that one is a remark beside the Use button, never a refusal: a folded
      page, an odd state licence and a badly framed corner all land here, and none of them is
      grounds for throwing away a scan somebody has just taken.
    */
    const found = quad ?? fallback;
    const verdict = quad ? shapeVerdict(quadAspect(quad), profile.shape) : 'fits';
    setShot({
      image,
      quad: verdict === 'sideways' ? rotateQuad(found) : found,
      guessed: !quad,
      remark: shapeRemark(verdict, profile.shape),
      turned: verdict === 'sideways',
    });
    setStage('captured');
    stopCamera();
  };

  // ── Dragging the corners ──────────────────────────────────────────────────

  /** Where a pointer is, in the still's own pixels rather than the screen's. */
  const toImagePoint = (e: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = stillRef.current;
    if (!canvas || !shot) return null;
    const box = canvas.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: ((e.clientX - box.left) / box.width) * shot.image.width,
      y: ((e.clientY - box.top) / box.height) * shot.image.height,
    };
  };

  const moveCorner = (e: React.PointerEvent<HTMLCanvasElement>, index?: number) => {
    const corner = index ?? dragging.current;
    if (corner === null || corner === undefined) return;
    const p = toImagePoint(e);
    if (!p || !shot) return;
    const clamped = {
      x: Math.max(0, Math.min(shot.image.width, p.x)),
      y: Math.max(0, Math.min(shot.image.height, p.y)),
    };
    setShot((prev) => {
      if (!prev) return prev;
      const quad = [...prev.quad] as Quad;
      quad[corner] = clamped;
      return { ...prev, quad, guessed: false };
    });
  };

  const grabCorner = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toImagePoint(e);
    if (!p || !shot) return;
    let nearest = 0;
    let best = Infinity;
    shot.quad.forEach((corner, i) => {
      const d = Math.hypot(corner.x - p.x, corner.y - p.y);
      if (d < best) { best = d; nearest = i; }
    });
    // Only within reach of a corner, so a stray tap in the middle of the page does not fling one.
    if (best > Math.max(shot.image.width, shot.image.height) * 0.25) return;
    dragging.current = nearest;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    moveCorner(e, nearest);
  };

  /** The still with the current outline painted over it — redrawn whenever a corner moves. */
  useEffect(() => {
    if (stage !== 'captured' || !shot) return;
    const canvas = stillRef.current;
    if (!canvas) return;
    canvas.width = shot.image.width;
    canvas.height = shot.image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(shot.image, 0, 0);

    ctx.beginPath();
    shot.quad.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(34,197,94,0.95)';
    ctx.lineWidth = Math.max(3, canvas.width / 260);
    ctx.fillStyle = 'rgba(34,197,94,0.10)';
    ctx.fill();
    ctx.stroke();

    const handle = Math.max(10, canvas.width / 52);
    shot.quad.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, handle, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, canvas.width / 400);
      ctx.strokeStyle = 'rgba(21,128,61,1)';
      ctx.stroke();
    });
  }, [stage, shot]);

  // ── Turning the shot into a file ──────────────────────────────────────────

  const buildPage = async (): Promise<File | null> => {
    if (!shot) return null;
    const size = quadOutputSize(shot.quad, MAX_OUTPUT_EDGE);
    const flat = warpQuad(
      shot.image.data, shot.image.width, shot.image.height, shot.quad, size.width, size.height,
    );
    if (!flat) return null;
    const finished = enhance(flat, size.width, size.height, finish);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // Built through the context rather than `new ImageData(...)`: the constructor demands a
    // buffer-backed array the enhancer has no reason to promise, and this copies into one.
    const out = ctx.createImageData(size.width, size.height);
    out.data.set(finished);
    ctx.putImageData(out, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.9);
    });
    if (!blob) return null;
    // Named by the shared rule, the same one the phone's scanner uses — this had its own slug
    // expression and the mobile app had another, which is two answers to "what is this file called".
    return new File(
      [blob],
      scanFileName(documentLabel, 'jpg', new Date(), pages.length + 1),
      { type: 'image/jpeg' },
    );
  };

  const keepPage = async (andAnother: boolean) => {
    setWorking(true);
    try {
      const file = await buildPage();
      if (!file) { setWorking(false); return; }
      const all = [...pages, file];
      if (andAnother) {
        setPages(all);
        setShot(null);
        await startCamera();
      } else {
        onScanned(all);
      }
    } finally {
      setWorking(false);
    }
  };

  const retake = async () => {
    setShot(null);
    await startCamera();
  };

  const close = () => {
    stopCamera();
    onCancel();
  };

  // ── What it looks like ────────────────────────────────────────────────────

  const shell: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 3000, background: '#0b0f14',
    display: 'flex', flexDirection: 'column', color: '#f8fafc',
  };

  return (
    <div
      style={shell}
      role="dialog"
      aria-modal="true"
      aria-label={`Scan ${documentLabel}`}
      // The finish in force, on the element rather than only inside a closure. The chooser itself
      // only exists after a capture — which needs a canvas, which jsdom has not got — so without
      // this there is no way to prove a signed form starts on the finish that keeps a signature
      // and a PAN card starts in colour. It reflects state; it does not create any.
      data-finish={finish}
    >
      <header style={{
        display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px',
        borderBottom: '1px solid rgba(255,255,255,0.12)',
      }}
      >
        <Camera size={16} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{documentLabel}</div>
          <div style={{ fontSize: 'var(--text-2xs)', opacity: 0.75 }}>
            {pages.length > 0
              ? `${pages.length} page${pages.length === 1 ? '' : 's'} scanned`
              : profile.hint}
          </div>
        </div>
        {stage === 'live' && torchable && (
          <button
            type="button"
            onClick={() => void toggleTorch()}
            aria-label={torchOn ? 'Turn the light off' : 'Turn the light on'}
            style={ghostButton}
          >
            {torchOn ? <Zap size={16} /> : <ZapOff size={16} />}
          </button>
        )}
        <button type="button" onClick={close} aria-label="Close the scanner" style={ghostButton}>
          <X size={18} />
        </button>
      </header>

      <div style={{
        flex: 1, minHeight: 0, position: 'relative', display: 'flex',
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}
      >
        {stage === 'refused' ? (
          <div style={{
            padding: '24px', maxWidth: '420px', textAlign: 'center',
            fontSize: 'var(--text-sm)', lineHeight: 1.6,
          }}
          >
            {refusal}
          </div>
        ) : stage === 'captured' && shot ? (
          <canvas
            ref={stillRef}
            aria-label="Drag the corners onto the document"
            onPointerDown={grabCorner}
            onPointerMove={(e) => { if (dragging.current !== null) moveCorner(e); }}
            onPointerUp={() => { dragging.current = null; }}
            onPointerCancel={() => { dragging.current = null; }}
            style={{ maxWidth: '100%', maxHeight: '100%', touchAction: 'none', cursor: 'grab' }}
          />
        ) : (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ maxWidth: '100%', maxHeight: '100%', display: stage === 'live' ? 'block' : 'none' }}
            />
            <canvas
              ref={overlayRef}
              style={{
                position: 'absolute', maxWidth: '100%', maxHeight: '100%',
                pointerEvents: 'none', display: stage === 'live' ? 'block' : 'none',
              }}
            />
            {stage === 'starting' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
                <Loader2 size={16} /> Opening the camera…
              </div>
            )}
          </>
        )}
      </div>

      <footer style={{ padding: '12px 14px 18px', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
        {stage === 'captured' && shot ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {(shot.guessed || shot.remark || shot.turned) && (
              <div style={{ fontSize: 'var(--text-2xs)', opacity: 0.85, textAlign: 'center' }}>
                {shot.guessed
                  ? 'The edges of the document were not found — drag the four corners onto them.'
                  : shot.remark ?? 'Held sideways, so the scan has been turned upright.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {FINISHES.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  title={f.hint}
                  onClick={() => setFinish(f.value)}
                  style={{
                    ...ghostButton,
                    fontSize: 'var(--text-xs)',
                    padding: '7px 11px',
                    background: finish === f.value ? 'rgba(59,130,246,0.28)' : 'rgba(255,255,255,0.08)',
                  }}
                >
                  {f.icon}{f.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={() => void retake()} disabled={working} style={ghostButton}>
                <RotateCcw size={14} /> Retake
              </button>
              {multiPage && (
                <button type="button" onClick={() => void keepPage(true)} disabled={working} style={ghostButton}>
                  <Plus size={14} /> Another page
                </button>
              )}
              <button
                type="button"
                onClick={() => void keepPage(false)}
                disabled={working}
                style={{ ...ghostButton, background: 'rgba(34,197,94,0.9)', color: '#052e16', fontWeight: 600 }}
              >
                {working ? <Loader2 size={14} /> : <Check size={14} />}
                {pages.length > 0 ? `Use ${pages.length + 1} pages` : 'Use this scan'}
              </button>
            </div>
          </div>
        ) : stage === 'refused' ? (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button type="button" onClick={close} style={ghostButton}>Close</button>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button
              type="button"
              onClick={capture}
              disabled={stage !== 'live'}
              aria-label="Take the scan"
              style={{
                width: 64, height: 64, borderRadius: '50%', border: '4px solid rgba(255,255,255,0.9)',
                background: stage === 'live' ? '#f8fafc' : 'rgba(248,250,252,0.35)', cursor: 'pointer',
              }}
            />
          </div>
        )}
      </footer>
    </div>
  );
};

/**
 * The starting corners when nothing was detected: the guide outline itself, or the whole frame
 * where there is no expected shape.
 *
 * Starting from a card-shaped crop on a card row means the commonest correction — nudging two
 * corners — rather than dragging all four in from the edges of a photograph of a desk.
 */
function guideQuad(width: number, height: number, shape: ScanShape, inset: number): Quad {
  if (shape === 'free') {
    return [
      { x: inset, y: inset },
      { x: width - inset, y: inset },
      { x: width - inset, y: height - inset },
      { x: inset, y: height - inset },
    ];
  }
  const aspect = SCAN_SHAPE_ASPECT[shape];
  let w = width * 0.84;
  let h = w / aspect;
  if (h > height * 0.84) {
    h = height * 0.84;
    w = h * aspect;
  }
  const x = (width - w) / 2;
  const y = (height - h) / 2;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

/**
 * The outline of the document this row is asking for, drawn over the viewfinder.
 *
 * This is the whole point of knowing what the document is: somebody holding a PAN card sees a card
 * to fill, not an empty rectangle, and the scan that comes back is framed rather than centred on a
 * desk. Dimmed outside rather than hidden, because the guide is advice — the detector still works
 * anywhere in the frame, and a document that will not fit the outline is still perfectly scannable.
 */
function drawGuide(
  ctx: CanvasRenderingContext2D, width: number, height: number, shape: ScanShape,
): void {
  if (shape === 'free') return;
  const aspect = SCAN_SHAPE_ASPECT[shape];
  // 84% of whichever dimension binds, so the outline never touches the edges of the frame: a
  // document pressed right up against them loses the corner the detector needs to see.
  let w = width * 0.84;
  let h = w / aspect;
  if (h > height * 0.84) {
    h = height * 0.84;
    w = h * aspect;
  }
  const x = (width - w) / 2;
  const y = (height - h) / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.rect(x, y, w, h);
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = Math.max(2, width / 400);
  ctx.setLineDash([Math.max(8, width / 40), Math.max(6, width / 60)]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

const ghostButton: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: '6px',
  background: 'rgba(255,255,255,0.10)', color: 'inherit',
  border: '1px solid rgba(255,255,255,0.18)', borderRadius: '999px',
  padding: '9px 14px', fontSize: 'var(--text-xs)', fontFamily: 'inherit', cursor: 'pointer',
};

export default DocumentScanner;
