import React, { useState } from 'react';
import { Download, ExternalLink, ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight, FileText } from 'lucide-react';
import { scanMimeType, isDrawableScanType } from '@fapoms/shared';
import { Modal } from './ui/Modal';

export interface DocumentPreviewItem {
  title: string;
  url: string;
  fileName?: string;
  mimeType?: string;
}

export const DocumentPreviewModal: React.FC<{
  open: boolean;
  onClose: () => void;
  items: DocumentPreviewItem[];
  initialIndex?: number;
}> = ({ open, onClose, items, initialIndex = 0 }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  React.useEffect(() => {
    if (open) {
      setCurrentIndex(Math.min(Math.max(0, initialIndex), Math.max(0, items.length - 1)));
      setZoom(1);
      setRotation(0);
    }
  }, [open, initialIndex, items.length]);

  if (!open || items.length === 0) return null;

  const current = items[currentIndex] || items[0];
  /*
    THE FALLBACK USED TO BE DEAD CODE. It read `current.url || current.fileName`, and `url` is
    always a `blob:` URL — truthy, and carrying no extension — so the filename was never reached and
    the test never matched. Anything arriving without a type (which is everything off a document
    route: they stream with no usable `Content-Type`) fell through to a download button. The name is
    what still knows, so the name is what gets asked, through the one shared rule.
  */
  const fromName = scanMimeType(current.fileName);
  const type = current.mimeType && current.mimeType !== 'application/octet-stream'
    ? current.mimeType
    : fromName;
  const isImage = isDrawableScanType(type);
  const isPdf = type === 'application/pdf';
  const hasMultiple = items.length > 1;

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setZoom(1);
      setRotation(0);
    }
  };

  const handleNext = () => {
    if (currentIndex < items.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setZoom(1);
      setRotation(0);
    }
  };

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = current.url;
    a.download = current.fileName || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="820px"
      dismissOnBackdrop
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minWidth: 0, paddingRight: '8px' }}>
          <FileText size={16} style={{ color: isImage ? 'var(--accent)' : 'var(--warning)', flexShrink: 0 }} />
          <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {current.title}
          </span>
          {hasMultiple && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', flexShrink: 0 }}>
              ({currentIndex + 1}/{items.length})
            </span>
          )}
        </div>
      }
    >
      {/* Mobile-friendly preview toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '6px',
        padding: '6px 10px',
        marginBottom: '8px',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-sm, 6px)',
        fontSize: 'var(--text-xs)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isImage && (
            <>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
                title="Zoom out"
                className="btn btn-secondary"
                style={{ padding: '6px 10px', minHeight: '34px', fontSize: 'var(--text-xs)' }}
              >
                <ZoomOut size={14} />
              </button>
              <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 600, minWidth: '42px', textAlign: 'center', color: 'var(--text-muted)' }}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
                title="Zoom in"
                className="btn btn-secondary"
                style={{ padding: '6px 10px', minHeight: '34px', fontSize: 'var(--text-xs)' }}
              >
                <ZoomIn size={14} />
              </button>
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                title="Rotate clockwise (90°)"
                className="btn btn-secondary"
                style={{ padding: '6px 10px', minHeight: '34px', fontSize: 'var(--text-xs)' }}
              >
                <RotateCw size={14} />
              </button>
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            onClick={handleDownload}
            title="Download file"
            className="btn btn-secondary"
            style={{ padding: '6px 11px', minHeight: '34px', fontSize: 'var(--text-xs)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
          >
            <Download size={14} /> <span>Download</span>
          </button>
          <a
            href={current.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in new tab"
            className="btn btn-secondary"
            style={{ padding: '6px 10px', minHeight: '34px', fontSize: 'var(--text-xs)', display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none' }}
          >
            <ExternalLink size={14} />
          </a>
        </div>
      </div>
      <div style={{ position: 'relative', minHeight: '400px', maxHeight: '72vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-card)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
        {hasMultiple && (
          <>
            <button
              type="button"
              onClick={handlePrev}
              disabled={currentIndex === 0}
              style={{
                position: 'absolute',
                left: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: '50%',
                width: '34px',
                height: '34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: currentIndex === 0 ? 'not-allowed' : 'pointer',
                opacity: currentIndex === 0 ? 0.3 : 0.85,
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}
              aria-label="Previous scan"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={currentIndex === items.length - 1}
              style={{
                position: 'absolute',
                right: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-color)',
                borderRadius: '50%',
                width: '34px',
                height: '34px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: currentIndex === items.length - 1 ? 'not-allowed' : 'pointer',
                opacity: currentIndex === items.length - 1 ? 0.3 : 0.85,
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              }}
              aria-label="Next scan"
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}

        {isImage ? (
          <div style={{ width: '100%', height: '100%', minHeight: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto', padding: '16px' }}>
            <img
              src={current.url}
              alt={current.title}
              style={{
                maxWidth: zoom === 1 ? '100%' : 'none',
                maxHeight: zoom === 1 ? '65vh' : 'none',
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: 'transform 0.15s ease-out',
                borderRadius: 'var(--radius-sm)',
                boxShadow: '0 4px 14px rgba(0,0,0,0.1)',
                display: 'block',
              }}
            />
          </div>
        ) : isPdf ? (
          <iframe
            src={current.url}
            title={current.title}
            style={{ width: '100%', height: '65vh', border: 'none', borderRadius: 'var(--radius-sm)' }}
          />
        ) : (
          <div style={{ textAlign: 'center', padding: '32px' }}>
            <FileText size={48} style={{ color: 'var(--text-muted)', marginBottom: '12px' }} />
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>{current.fileName || current.title}</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '4px', marginBottom: '16px' }}>
              Preview is not available for this file type.
            </div>
            <button type="button" onClick={handleDownload} className="btn btn-primary" style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}>
              Download to view
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
};
