import React, { useState } from 'react';
import { HelpCircle, ChevronDown, ChevronUp } from 'lucide-react';
import {
  DOCUMENT_STAGE, DOCUMENT_STAGE_ORDER, DOCUMENT_TYPE, DOCUMENT_TYPE_ORDER, documentTypeLabel,
} from './vocabulary';

/**
 * Built FROM the words the badges use, never written out again.
 *
 * This list used to be its own prose copy, and it had already fallen behind: it collapsed
 * "Excel ready" and "Completed" into one row while the badges showed them separately, and it
 * named the first file type "Customer Master Excel" where the rest of the product says
 * "Customer Master Data". An explainer that disagrees with the thing it explains leaves a
 * reader worse off than no explainer at all — which matters here, because this panel exists
 * precisely because the model is not obvious.
 */
const TYPES = DOCUMENT_TYPE_ORDER.map((t) => ({
  type: documentTypeLabel(t),
  who: DOCUMENT_TYPE[t].who,
  purpose: DOCUMENT_TYPE[t].purpose,
}));

const STAGES = DOCUMENT_STAGE_ORDER.map((s) => ({
  stage: DOCUMENT_STAGE[s].label,
  meaning: DOCUMENT_STAGE[s].meaning,
}));


/**
 * A compact, dismissible explainer for the document model — what each file type
 * is for, what each pipeline stage means, and the one scoping rule that isn't
 * obvious from the UI: documents belong to a branch's audit cycle, not to
 * whichever assayer happens to be assigned to it.
 */
export const DocumentModelLegend: React.FC = () => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--text-xs)', fontWeight: 600,
        }}
      >
        <HelpCircle size={14} />
        What are these files and states?
        <span style={{ marginLeft: 'auto', display: 'flex' }}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
          <div>
            <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 8 }}>File types</div>
            {TYPES.map((t) => (
              <div key={t.type} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{t.type} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {t.who}</span></div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>{t.purpose}</div>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-3xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 8 }}>Pipeline stages</div>
            {STAGES.map((s) => (
              <div key={s.stage} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600 }}>{s.stage}</div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>{s.meaning}</div>
              </div>
            ))}
            <div style={{ marginTop: 12, padding: '9px 11px', background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              <strong>Scope:</strong> every file belongs to one branch within one project cycle — not to whichever
              assayer is currently assigned. If the assayer changes, these files and their state stay exactly as they are.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
