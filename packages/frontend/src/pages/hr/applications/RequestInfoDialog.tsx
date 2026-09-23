import React, { useMemo, useState } from 'react';
import {
  APPLICATION_INFO_REQUESTABLE_FIELDS, DOCUMENT_REJECTION_LABELS, ONBOARDING_DOCUMENT_LABELS,
  type OnboardingDocument,
} from '@fapoms/shared';
import { Select } from '../../../components/ui';
import { Editor } from '../hr-ui';

export interface RequestInfoDocumentAsk {
  requirement: string;
  reason?: string;
  note?: string;
}

export interface RequestInfoFieldAsk {
  key: string;
  message?: string;
}

export interface RequestInfoPayload {
  notes: string;
  documents: RequestInfoDocumentAsk[];
  fields: RequestInfoFieldAsk[];
}

/**
 * Ask the candidate for exactly what is needed — ticked documents and fields, each with its
 * own instruction — instead of one free-text note they have to decode.
 *
 * The candidate reopens the SAME link with only these items flagged, so every tick here must
 * be something they can actually fix there: document requirements from the requested list (or
 * already attached), and form fields from the shared requestable list the link accepts.
 */
export const RequestInfoDialog: React.FC<{
  candidateName: string;
  documents: Array<{ requirement: string; fileCount: number; reviewStatus?: string | null }>;
  documentsRequested: string[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (payload: RequestInfoPayload) => void;
}> = ({ candidateName, documents, documentsRequested, busy, error, onCancel, onSubmit }) => {
  const [tickedDocs, setTickedDocs] = useState<Record<string, { reason: string; note: string }>>({});
  const [tickedFields, setTickedFields] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');

  const docRows = useMemo(() => {
    const attached = new Map(documents.map((d) => [d.requirement, d]));
    const keys = new Set<string>([...documentsRequested, ...attached.keys()]);
    return [...keys].map((requirement) => ({
      requirement,
      label: ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement,
      fileCount: attached.get(requirement)?.fileCount ?? 0,
      sentBack: attached.get(requirement)?.reviewStatus === 'NEEDS_RESUBMIT',
    }));
  }, [documents, documentsRequested]);

  const toggleDoc = (requirement: string) => setTickedDocs((prev) => {
    if (prev[requirement]) {
      const { [requirement]: _dropped, ...rest } = prev;
      return rest;
    }
    return { ...prev, [requirement]: { reason: '', note: '' } };
  });

  const toggleField = (key: string) => setTickedFields((prev) => {
    if (key in prev) {
      const { [key]: _dropped, ...rest } = prev;
      return rest;
    }
    return { ...prev, [key]: '' };
  });

  const askCount = Object.keys(tickedDocs).length + Object.keys(tickedFields).length;
  const canSend = askCount > 0 || notes.trim() !== '';

  const fieldStyle: React.CSSProperties = {
    width: '100%', padding: '7px 9px', fontSize: 'var(--text-xs)', fontFamily: 'inherit',
    background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', outline: 'none',
    boxSizing: 'border-box',
  };
  const rowStyle: React.CSSProperties = {
    display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '7px 9px',
    borderRadius: '6px', background: 'var(--bg-surface)', border: '1px solid var(--border-hair)',
  };

  return (
    <Editor
      title={`Request from ${candidateName}`}
      onCancel={onCancel}
      onSave={() => onSubmit({
        notes: notes.trim(),
        documents: Object.entries(tickedDocs).map(([requirement, v]) => ({
          requirement,
          ...(v.reason ? { reason: v.reason } : {}),
          ...(v.note.trim() ? { note: v.note.trim() } : {}),
        })),
        fields: Object.entries(tickedFields).map(([key, message]) => ({
          key,
          ...(message.trim() ? { message: message.trim() } : {}),
        })),
      })}
      saveLabel={askCount > 0 ? `Send ${askCount} request${askCount === 1 ? '' : 's'}` : 'Send request'}
      saveDisabled={!canSend}
      busy={busy}
      error={error}
      width={620}
    >
      <div>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
          Documents
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '220px', overflowY: 'auto' }}>
          {docRows.map((doc) => {
            const ticked = Boolean(tickedDocs[doc.requirement]);
            return (
              <div key={doc.requirement}>
                <label style={{ ...rowStyle, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() => toggleDoc(doc.requirement)}
                    style={{ marginTop: '2px' }}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', flex: 1 }}>
                    <strong>{doc.label}</strong>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}· {doc.fileCount} file{doc.fileCount === 1 ? '' : 's'}
                    </span>
                  </span>
                </label>
                {ticked && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', margin: '6px 0 2px 26px' }}>
                    <Select
                      value={tickedDocs[doc.requirement].reason}
                      onChange={(v) => setTickedDocs((prev) => ({
                        ...prev, [doc.requirement]: { ...prev[doc.requirement], reason: String(v) },
                      }))}
                      options={Object.entries(DOCUMENT_REJECTION_LABELS).map(([value, label]) => ({ value, label: label as string }))}
                      placeholder="Reason (optional)"
                      aria-label={`Why ${doc.label} is being sent back`}
                    />
                    <textarea
                      value={tickedDocs[doc.requirement].note}
                      onChange={(e) => setTickedDocs((prev) => ({
                        ...prev, [doc.requirement]: { ...prev[doc.requirement], note: e.target.value },
                      }))}
                      rows={2}
                      maxLength={1000}
                      placeholder="Instruction for the candidate"
                      style={{ ...fieldStyle, resize: 'vertical' }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '6px' }}>
          Fields
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
          {APPLICATION_INFO_REQUESTABLE_FIELDS.map((field) => {
            const ticked = field.key in tickedFields;
            return (
              <div key={field.key}>
                <label style={{ ...rowStyle, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={ticked}
                    onChange={() => toggleField(field.key)}
                    style={{ marginTop: '2px' }}
                  />
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)' }}>{field.label}</span>
                </label>
                {ticked && (
                  <div style={{ margin: '6px 0 2px 26px' }}>
                    <input
                      value={tickedFields[field.key]}
                      onChange={(e) => setTickedFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                      maxLength={1000}
                      placeholder="Instruction for the candidate"
                      style={fieldStyle}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <label htmlFor="request-info-notes" style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
          Note
        </label>
        <textarea
          id="request-info-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Optional note for the candidate"
          style={{ ...fieldStyle, resize: 'vertical' }}
        />
      </div>
    </Editor>
  );
};

export default RequestInfoDialog;
