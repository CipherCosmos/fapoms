import React, { useEffect, useState } from 'react';
import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { isDrawableScan, scanMimeType } from '@fapoms/shared';

/**
 * ONE ATTACHED FILE, SHOWN AS WHAT IT IS.
 *
 * The row used to say "Uploaded & attached (1 file)" — true, and no help to somebody who wants to
 * know whether the photo they just took is the blurred one. A picture of the picture answers that
 * at a glance; tapping it opens the full view. A PDF cannot be drawn this small, so it shows as a
 * PDF with its page count when this session knows it (a scan it built itself).
 *
 * The file is fetched through the same token route the preview uses; a thumbnail that cannot be
 * fetched falls back to a plain icon rather than an error — the file is still attached.
 */
export const DocumentThumb: React.FC<{
  /** The stored key — decides image-or-PDF, and re-fetches when a retake replaces the file. */
  filePath: string;
  /** Fetches this file's bytes. */
  load: () => Promise<Blob>;
  /** Pages in this PDF, when known. */
  pages?: number | null;
  /** Names the file for screen readers: "PAN card", "Rent agreement file 2". */
  name: string;
  onOpen: () => void;
  onRemove?: () => void;
  removing?: boolean;
}> = ({ filePath, load, pages, name, onOpen, onRemove, removing = false }) => {
  const drawable = isDrawableScan(filePath);
  const isPdf = scanMimeType(filePath) === 'application/pdf';
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!drawable || typeof URL.createObjectURL !== 'function') return undefined;
    let live = true;
    let made: string | null = null;
    load()
      .then((blob) => {
        if (!live || !(blob instanceof Blob)) return;
        // Re-typed from the name: the route streams bytes without a usable Content-Type.
        const type = scanMimeType(filePath);
        made = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
        setUrl(made);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
    // `load` is a fresh closure each render; the file is what identifies the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, drawable]);

  return (
    <div style={{ position: 'relative', width: '64px', height: '64px', flexShrink: 0 }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${name}`}
        title="Tap to see it full size"
        style={{
          width: '100%', height: '100%', padding: 0, borderRadius: '8px', overflow: 'hidden',
          border: '1px solid color-mix(in srgb, var(--success) 45%, var(--border-color))',
          background: 'var(--bg-surface-2)', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2px',
          color: 'var(--text-secondary)',
        }}
      >
        {url ? (
          <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : isPdf ? (
          <>
            <FileText size={22} />
            <span style={{ fontSize: 'var(--text-3xs)', fontWeight: 700 }}>
              PDF{pages ? ` · ${pages} page${pages === 1 ? '' : 's'}` : ''}
            </span>
          </>
        ) : (
          <ImageIcon size={22} />
        )}
      </button>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={removing}
          aria-label={`Remove ${name}`}
          title="Remove this file"
          style={{
            position: 'absolute', top: '-8px', right: '-8px', width: '24px', height: '24px',
            borderRadius: '50%', border: '1px solid var(--border-color)', background: 'var(--bg-surface)',
            color: 'var(--danger)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, cursor: removing ? 'wait' : 'pointer', opacity: removing ? 0.6 : 1,
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
};

export default DocumentThumb;
