import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PdfRegionViewer } from './dataentry/PdfRegionViewer';

/**
 * The desk's mark, shown on the assayer's own packet — a public, link-authorised page.
 *
 * When the data-entry desk anchors a clarification to a rectangle on a page of the audit PDF, the
 * assayer used to receive a cropped screenshot of that spot. A crop loses all context: which row,
 * which column, what sits above and below. This page instead opens the REAL page of the REAL
 * packet with the marked rectangle highlighted, so the field worker sees the questioned cell in
 * place and can scroll and zoom around it.
 *
 * It is deliberately outside the authenticated app (see App.tsx): the assayer taps a link in the
 * mobile clarification chat and it opens in their phone's OS browser, where there is no web
 * session. Authorisation is the signed, short-lived `token` in the URL, which the packet download
 * endpoint verifies on its own — exactly the same token the packet-download button already uses.
 *
 * The bytes are fetched once, here, and handed to the viewer as an in-memory object URL. That
 * keeps it to a single download on the weak rural connections these workers are usually on, and
 * lets this page tell an expired or broken link apart from a merely slow one and say so plainly.
 */

interface ParsedRegion { x: number; y: number; w: number; h: number }

/** "x,y,w,h" (normalised 0..1) → a region, or null when absent or malformed. */
const parseRegion = (raw: string | null): ParsedRegion | null => {
  if (!raw) return null;
  const parts = raw.split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts;
  return { x, y, w, h };
};

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-page)',
      color: 'var(--text-primary)',
    }}
  >
    {children}
  </div>
);

export const ViewMark: React.FC = () => {
  const [params] = useSearchParams();
  const documentId = params.get('documentId');
  const token = params.get('token');
  const page = Math.max(1, Math.trunc(Number(params.get('page')) || 1));
  const region = useMemo(() => parseRegion(params.get('region')), [params]);

  // 'loading' → fetching the packet bytes; 'ready' → have them; 'error' → link is unusable.
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(
    documentId && token ? 'loading' : 'error',
  );
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId || !token) {
      setState('error');
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState('loading');
    // Same-origin, token-authorised — no session, no auth header. The token IS the credential.
    fetch(`/api/v1/documents/${encodeURIComponent(documentId)}/download?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPdfUrl(objectUrl);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
      // Release the in-memory copy when the page or its params change.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [documentId, token]);

  const header = (
    <div
      style={{
        flex: '0 0 auto',
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-card)',
      }}
    >
      <div style={{ fontSize: '15px', fontWeight: 600 }}>Marked by the desk</div>
      <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>
        Page {page}
      </div>
    </div>
  );

  if (state === 'error') {
    return (
      <Frame>
        {header}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <div style={{ maxWidth: '320px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px' }}>
              This link has expired
            </div>
            <div style={{ fontSize: '14px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Ask the desk to resend it, then open the new link.
            </div>
          </div>
        </div>
      </Frame>
    );
  }

  if (state === 'loading' || !pdfUrl) {
    return (
      <Frame>
        {header}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: '14px',
          }}
        >
          Opening your document…
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      {header}
      {/* The shared viewer, read-only: no marking tools, the highlight stays put over the cell,
          and the whole page scrolls and zooms so the context around the mark is visible. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <PdfRegionViewer fileUrl={pdfUrl} viewOnly focus={{ pageNumber: page, region }} />
      </div>
    </Frame>
  );
};

export default ViewMark;
