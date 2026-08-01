import React, { useState } from 'react';
import { HelpCircle, ChevronDown, ChevronUp } from 'lucide-react';

const TYPES: Array<{ type: string; who: string; purpose: string }> = [
  { type: 'Customer Master Excel', who: 'Ops uploads', purpose: "The bank's customer account extract for this branch. Run through OCR/reconciliation before the audit." },
  { type: 'Pre-Field Audit PDF', who: 'Ops uploads → sent to assayer', purpose: 'The packet the assayer needs to actually do the audit. Nothing downloads on the assayer\'s phone until this is dispatched.' },
  { type: 'Audited Return PDF', who: 'Assayer uploads from the field', purpose: 'The completed paperwork, scanned and submitted after the visit. This is what data entry works from.' },
  { type: 'Generated Excel', who: 'Data entry uploads', purpose: 'The structured output produced after external OCR processes the audited return.' },
];

const STAGES: Array<{ stage: string; meaning: string }> = [
  { stage: 'Prepared', meaning: 'Uploaded internally. Not visible to the assayer yet.' },
  { stage: 'With assayer', meaning: 'Dispatched — the assayer can now see and download it.' },
  { stage: 'Returned', meaning: 'The assayer submitted their completed paperwork.' },
  { stage: 'Data entry', meaning: 'Handed to the Data Entry Head\'s queue for processing.' },
  { stage: 'External OCR', meaning: 'Pushed to the outside OCR application manually.' },
  { stage: 'Excel ready / Completed', meaning: 'The structured result is back and the file\'s journey is done.' },
];

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
          background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 12.5, fontWeight: 600,
        }}
      >
        <HelpCircle size={14} />
        What are these files and states?
        <span style={{ marginLeft: 'auto', display: 'flex' }}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 18 }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 8 }}>File types</div>
            {TYPES.map((t) => (
              <div key={t.type} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t.type} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {t.who}</span></div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>{t.purpose}</div>
              </div>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 8 }}>Pipeline stages</div>
            {STAGES.map((s) => (
              <div key={s.stage} style={{ marginBottom: 9 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{s.stage}</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>{s.meaning}</div>
              </div>
            ))}
            <div style={{ marginTop: 12, padding: '9px 11px', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 'var(--radius-sm)', fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              <strong>Scope:</strong> every file belongs to one branch within one project cycle — not to whichever
              assayer is currently assigned. If the assayer changes, these files and their state stay exactly as they are.
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
