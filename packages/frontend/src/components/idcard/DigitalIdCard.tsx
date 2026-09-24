import React from 'react';

/** The card's content, exactly as the server decides it (`idCardFace`). */
export interface IdCardFaceData {
  issued: boolean;
  blockedBecause: string[];
  gaps: string[];
  issuedOn: string;
  validTill: string;
  jobTitle: string;
  fullName: string;
  assayerCode: string;
  department: string | null;
  location: string | null;
  organisation: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  helplinePhone: string | null;
  officeAddress: string | null;
}

const NAVY = '#0b1633';
const INDIGO = '#1e2a6b';
const GOLD = '#d4a017';
const GOLD_SOFT = '#f4d77a';
const INK = '#0f172a';
const MUTED = '#64748b';

const fmt = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const initialsOf = (name: string) => (name || '').split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/**
 * THE DIGITAL ID CARD, as drawn on the web (owner, 2026-09-23). The phone app draws the same design
 * natively for the assayer; this one is for HR's preview, which is ALWAYS `preview` — the photograph
 * and name blurred, a repeated "PREVIEW · NOT VALID AS ID" watermark over it, and no code. A
 * screenshot of HR's screen is therefore not a card anybody could show at a bank counter. The only
 * card that proves anything is the live one in the assayer's own app, checked on /verify.
 */
export const DigitalIdCard: React.FC<{
  face: IdCardFaceData;
  photoUrl?: string | null;
  /** Always true today — the web never shows an unblurred card. Kept explicit so it reads as a decision. */
  preview: true;
}> = ({ face, photoUrl }) => (
  <div
    data-testid="digital-id-card"
    aria-label={`ID card preview for ${face.fullName} — blurred, not valid as identification`}
    style={{
      position: 'relative', width: '100%', maxWidth: '340px', margin: '0 auto', borderRadius: '20px', overflow: 'hidden',
      background: '#ffffff', color: INK, boxShadow: '0 12px 32px rgba(11, 22, 51, 0.28)', userSelect: 'none',
      fontFamily: 'inherit',
    }}
    onContextMenu={(e) => e.preventDefault()}
  >
    {/* Header: the organisation, over a deep gradient with a fine guilloché texture. */}
    <div style={{
      position: 'relative', height: '132px', padding: '16px 18px',
      background: `repeating-radial-gradient(circle at 80% -20%, rgba(255,255,255,0.05) 0 2px, transparent 2px 9px), linear-gradient(135deg, ${NAVY} 0%, ${INDIGO} 100%)`,
      color: '#fff', borderBottom: `3px solid ${GOLD}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
          <img src="/sumeru-logo.png" alt="" style={{ height: '28px', width: 'auto' }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 'var(--text-sm)', letterSpacing: '0.06em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {(face.organisation ?? 'SUMERU GLOBAL').toUpperCase()}
            </div>
            <div style={{ fontSize: 'var(--text-3xs)', letterSpacing: '0.18em', color: GOLD_SOFT }}>FIELD AUDIT OPERATIONS</div>
          </div>
        </div>
        <span style={{ fontSize: 'var(--text-3xs)', fontWeight: 800, letterSpacing: '0.14em', padding: '4px 8px', borderRadius: '999px', border: `1px solid ${GOLD_SOFT}`, color: GOLD_SOFT }}>
          DIGITAL ID
        </span>
      </div>
    </div>

    {/* Photo, overlapping the header. */}
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-58px', position: 'relative', zIndex: 1 }}>
      <div style={{
        width: '116px', height: '116px', borderRadius: '50%', padding: '4px', background: `conic-gradient(${GOLD}, ${GOLD_SOFT}, ${GOLD})`,
        boxShadow: '0 6px 16px rgba(0,0,0,0.25)',
      }}>
        <div style={{ width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {photoUrl
            ? <img src={photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(9px)', transform: 'scale(1.15)' }} />
            : <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: INDIGO, filter: 'blur(5px)' }}>{initialsOf(face.fullName)}</span>}
        </div>
      </div>
    </div>

    {/* Who. The name is blurred in the preview — HR knows whose record this is. */}
    <div style={{ textAlign: 'center', padding: '12px 18px 4px' }}>
      <div style={{ fontSize: 'var(--text-xl)', fontWeight: 800, color: NAVY, filter: 'blur(5px)' }}>{face.fullName}</div>
      <div style={{ display: 'inline-block', marginTop: '6px', padding: '3px 12px', borderRadius: '999px', background: '#fdf6e3', color: '#8a6100', fontSize: 'var(--text-2xs)', fontWeight: 800, letterSpacing: '0.08em' }}>
        {face.jobTitle.toUpperCase()}
      </div>
      <div style={{ marginTop: '8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--text-sm)', fontWeight: 700, color: INK, letterSpacing: '0.12em', filter: 'blur(4px)' }}>
        {face.assayerCode}
      </div>
    </div>

    {/* Facts. */}
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '12px 18px' }}>
      {[
        ['Valid until', fmt(face.validTill)],
        ['Status', face.issued ? 'Issued' : 'Not issued'],
        ...(face.location ? [['Based in', face.location]] : []),
        ...(face.department ? [['Department', face.department]] : []),
      ].map(([k, v]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 'var(--text-3xs)', letterSpacing: '0.12em', textTransform: 'uppercase', color: MUTED }}>{k}</div>
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: INK, overflowWrap: 'anywhere' }}>{v}</div>
        </div>
      ))}
    </div>

    {/* Where the live code goes — never on the web. */}
    <div style={{
      margin: '0 18px 14px', padding: '14px', borderRadius: '14px', border: '1px dashed #cbd5e1', background: '#f8fafc',
      textAlign: 'center', fontSize: 'var(--text-2xs)', color: MUTED, lineHeight: 1.5,
    }}>
      The live QR and 6-digit code appear only on the assayer&rsquo;s own app, and change every minute.
    </div>

    {/* Footer. */}
    <div style={{ background: '#f1f5f9', padding: '10px 18px', fontSize: 'var(--text-3xs)', color: MUTED, lineHeight: 1.5, display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
      <div style={{ minWidth: 0 }}>
        {face.helplinePhone && <div>If found, please call {face.helplinePhone}</div>}
        {face.officeAddress && <div style={{ overflowWrap: 'anywhere' }}>{face.officeAddress}</div>}
      </div>
      {(face.signatoryName || face.signatoryTitle) && (
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {face.signatoryName && <div style={{ fontWeight: 700, color: INK }}>{face.signatoryName}</div>}
          {face.signatoryTitle && <div>{face.signatoryTitle}</div>}
        </div>
      )}
    </div>

    {/* The watermark, over everything: a screenshot of this is visibly not an ID card. */}
    <div aria-hidden style={{
      position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    }}>
      <div style={{ transform: 'rotate(-28deg)', display: 'flex', flexDirection: 'column', gap: '34px' }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} style={{ whiteSpace: 'nowrap', fontSize: 'var(--text-base)', fontWeight: 900, letterSpacing: '0.2em', color: 'rgba(220, 38, 38, 0.22)' }}>
            PREVIEW · NOT VALID AS ID · PREVIEW · NOT VALID AS ID
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default DigitalIdCard;
