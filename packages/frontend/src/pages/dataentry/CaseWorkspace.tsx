import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Check, RotateCcw, Send as SubmitIcon, MessageSquarePlus, MessageSquare,
  Loader2, AlertTriangle, FileWarning, History as HistoryIcon,
} from 'lucide-react';

import { api } from '../../services/api';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { SystemRole, validationStatusLabel, activityEventLabel, validationQueryStatusLabel } from '@fapoms/shared';
import { counted } from '../../utils/plural';
import { PdfRegionViewer } from './PdfRegionViewer';
import type { RegionCapture, Region } from './PdfRegionViewer';
import { ThreadPanel } from './ThreadPanel';
import { userMessage } from '../../services/errors';
import { useConfirm } from '../../components/ui';

/**
 * The merged workspace for one branch's returned packet: the PDF, the data
 * entry head's review decision, and every clarification with the assayer —
 * three things that used to live on two disconnected pages (a Desk board with
 * no PDF, and a Validation page with a fake chat skin and no PDF either).
 *
 * Keyed by projectBranchId rather than a document or a case id, because a
 * branch's packet, its validation case, and its clarifications are the same
 * real-world unit of work at different moments — before a case exists (still
 * being typed in), while it is in review, and after it is approved or sent.
 * Whatever exists is shown; whatever doesn't yet is explained rather than
 * hidden as an error.
 */

interface DocRow {
  id: string; fileName: string; type: string; status: string; receivedAt: string | null;
}

interface CaseRow {
  id: string; status: string; remarks: string | null; correctionNotes: string | null;
  ocrResult: any | null;
  projectBranch?: { branch?: { name: string; branchCode: string } };
}

interface QueryRow {
  id: string; queryText: string; targetField: string | null; status: string;
  lastMessageAt?: string | null; createdAt: string;
}

interface TrailRow {
  at: string; eventType: string; actor: string | null;
  previousState: string | null; newState: string | null; remarks: string | null;
}

const STATUS_TONE: Record<string, string> = {
  PENDING: 'var(--text-muted)', ASSIGNED: 'var(--accent)', OCR_PROCESSING: 'var(--accent)',
  HUMAN_REVIEW: 'var(--warning)', CORRECTION_REQUIRED: 'var(--danger)',
  APPROVED: 'var(--success)', SUBMITTED: 'var(--success)',
};

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};
const panel: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
  borderRadius: '10px', overflow: 'hidden', minHeight: 0,
};

/**
 * Turns an OCR field name into something a data-entry clerk can read: `accountNumber` and
 * `account_number` both become "Account number". The payload is untyped jsonb end to end
 * (`ocrResult` is `any` on the entity and in the API), so there is no field list to map
 * against — humanising the key we were given is the most this can honestly do.
 */
function ocrFieldLabel(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** A single OCR value as text. Nested objects/arrays have no sensible row form — say so. */
function ocrFieldValue(value: unknown): { text: string; nested: boolean } {
  if (value === null || value === undefined || value === '') return { text: '—', nested: false };
  if (typeof value === 'boolean') return { text: value ? 'Yes' : 'No', nested: false };
  if (typeof value === 'number') return { text: value.toLocaleString('en-IN'), nested: false };
  if (typeof value === 'string') return { text: value, nested: false };
  if (Array.isArray(value)) {
    // A list of plain values reads fine on one line; a list of objects does not.
    if (value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
      return { text: value.map((v) => String(v)).join(', ') || '—', nested: false };
    }
    return { text: `${counted(value.length, 'item')} — see the raw data below`, nested: true };
  }
  return { text: 'See the raw data below', nested: true };
}

/**
 * What the scanner read, for the person doing the data entry.
 *
 * This used to be `JSON.stringify(ocrResult, null, 2)` in a 90px-tall <pre>: braces, quotes and
 * camelCase keys shown to a clerk whose job is to compare those values against the packet in
 * front of them. Plain rows are what that job needs.
 *
 * The raw payload is kept, not deleted, behind its own disclosure — the field set is whatever
 * the scanner happened to emit, so when a value looks wrong the only way to tell "the scanner
 * did not read it" from "we are not showing it" is to look at the original. That check is the
 * reason the raw dump was here in the first place.
 */
const OcrExtraction: React.FC<{ result: any }> = ({ result }) => {
  const entries = result && typeof result === 'object' && !Array.isArray(result)
    ? Object.entries(result as Record<string, unknown>)
    : [];

  return (
    <details style={{ marginBottom: '8px' }}>
      <summary style={{ ...label, cursor: 'pointer' }}>What the scanner read</summary>
      {entries.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0' }}>
          The scanner returned something this screen cannot lay out as fields. The raw data is below.
        </div>
      ) : (
        <div style={{ margin: '6px 0 0', maxHeight: '170px', overflowY: 'auto' }}>
          {entries.map(([k, v], i) => {
            const { text, nested } = ocrFieldValue(v);
            return (
              <div key={k} style={{
                display: 'flex', gap: '10px', alignItems: 'baseline', padding: '4px 0',
                borderTop: i > 0 ? '1px solid var(--border-hair)' : 'none', fontSize: '12px',
              }}>
                <span style={{ color: 'var(--text-muted)', flex: '0 0 42%', minWidth: 0 }}>{ocrFieldLabel(k)}</span>
                <span style={{
                  flex: 1, minWidth: 0, wordBreak: 'break-word',
                  color: nested ? 'var(--text-muted)' : 'var(--text-primary)',
                  fontStyle: nested ? 'italic' : 'normal',
                }}>{text}</span>
              </div>
            );
          })}
        </div>
      )}
      <details style={{ marginTop: '8px' }}>
        <summary style={{ fontSize: '11px', color: 'var(--text-muted)', cursor: 'pointer' }}>Show raw data</summary>
        <pre style={{ fontSize: '11px', margin: '6px 0 0', overflowX: 'auto', maxHeight: '160px', color: 'var(--text-secondary)' }}>
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </details>
  );
};

export const CaseWorkspace: React.FC<{ projectBranchId: string; onBack: () => void; onChanged?: () => void }> = ({
  projectBranchId, onBack, onChanged,
}) => {
  const roles = useCurrentRoles();
  const { confirm, confirmDialog } = useConfirm();
  /**
   * The desk has two real roles. VALIDATORS are the working members: they key the packet,
   * run assayer clarifications (the chat below, phone calls), and hand the report back.
   * The review decision — approve, send back for correction, submit to the client — is the
   * HEAD's alone, so only heads see the decision controls. A validator seeing an Approve
   * button that 403s reads as a broken app, not a permissions boundary.
   */
  const canReview = roles.some((r) =>
    [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.DATA_ENTRY_HEAD, SystemRole.VALIDATION_MANAGER].includes(r));
  const canSubmit = canReview;

  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [validationCase, setCase] = useState<CaseRow | null | undefined>(undefined);
  const [queries, setQueries] = useState<QueryRow[] | null>(null);
  const [selectedQuery, setSelectedQuery] = useState<string | null>(null);
  const [newQueryText, setNewQueryText] = useState('');
  const [newQueryField, setNewQueryField] = useState('');
  const [newQueryUrgent, setNewQueryUrgent] = useState(false);
  const [showNewQuery, setShowNewQuery] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [pending, setPending] = useState<RegionCapture | null>(null);
  const [focus, setFocus] = useState<{ pageNumber: number; region: Region | null } | null>(null);

  // The PDF + clarifications split is a fixed two-column grid on the desktop it was
  // built for; below ~900px the two panels overlap and the 360px-min right column
  // pushes the layout wider than the screen. Track viewport width and stack them
  // vertically when narrow. Guarded for SSR/non-browser just in case.
  // The audit trail for this unit of work — every delegation, hand-back and decision,
  // with who and when. Fetched lazily on first open; it's evidence, not a hot path.
  const [showTrail, setShowTrail] = useState(false);
  const [trail, setTrail] = useState<TrailRow[] | null>(null);
  const toggleTrail = () => {
    const next = !showTrail;
    setShowTrail(next);
    if (next && trail === null && validationCase?.id) {
      api.request<TrailRow[]>(`/validation/${validationCase.id}/trail`)
        .then((r) => setTrail(Array.isArray(r) ? r : []))
        .catch(() => setTrail([]));
    }
  };

  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth < 900 : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const loadCase = useCallback(async () => {
    try {
      const list = await api.request<CaseRow[]>(`/validation?projectBranchId=${projectBranchId}&limit=1`);
      setCase(Array.isArray(list) && list.length > 0 ? list[0] : null);
    } catch (e) {
      setCase(null);
    }
  }, [projectBranchId]);

  const loadQueries = useCallback(async (caseId: string) => {
    api.request<QueryRow[]>(`/validation-queries/validation-case/${caseId}`)
      .then((r) => setQueries(Array.isArray(r) ? r : []))
      .catch(() => setQueries([]));
  }, []);

  useEffect(() => {
    api.request<DocRow[]>(`/documents/project-branch/${projectBranchId}`)
      .then((r) => setDocs(Array.isArray(r) ? r : []))
      .catch(() => setDocs([]));
    loadCase();
  }, [projectBranchId, loadCase]);

  useEffect(() => {
    if (validationCase?.id) loadQueries(validationCase.id);
    else setQueries(validationCase === null ? [] : null);
  }, [validationCase, loadQueries]);

  const returnedDoc = useMemo(
    () => docs?.find((d) => d.type === 'AUDITED_RETURN_PDF') ?? docs?.[0] ?? null,
    [docs],
  );

  useEffect(() => {
    if (!returnedDoc) { setFileUrl(null); return; }
    api.request<{ downloadUrl: string }>(`/documents/${returnedDoc.id}/download-token`)
      .then((r: any) => setFileUrl(r?.downloadUrl ? `/api/v1${r.downloadUrl}` : null))
      .catch((e) => setErr(`Could not open the document: ${(e as Error).message}`));
  }, [returnedDoc]);

  /**
   * "Submit to client" is the one action on this screen that leaves the building: it hands the
   * finished report to the outside party who commissioned the audit. Nothing in the product can
   * pull it back afterwards — the client has it. It sat unguarded next to Approve, in the same
   * button row, styled the same, so the click that a manager makes dozens of times a day to
   * approve was one position away from an external send that cannot be retracted. Approve and
   * Request correction stay unguarded: both are internal and both have a way back.
   */
  const decide = async (targetStatus: string) => {
    if (!validationCase) return;
    if (targetStatus === 'SUBMITTED') {
      const ok = await confirm({
        title: 'Send this report to the client?',
        message: (
          <>
            The report for <strong>{branchName ?? 'this branch'}</strong>
            {branchCode ? ` (${branchCode})` : ''} will be sent to the client as final.
          </>
        ),
        confirmLabel: 'Send to client',
        reversible: false,
        reversibleNote: 'Once sent, it cannot be recalled. Any correction has to be sent to the client separately.',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.request(`/validation/${validationCase.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus, notes: notes.trim() || undefined }),
      });
      setNotes('');
      await loadCase();
      onChanged?.();
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  const raiseQuery = async () => {
    if (!newQueryText.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      let caseId = validationCase?.id;
      if (!caseId) {
        // First question on a branch that has no case yet (still being worked) —
        // open one at PENDING so the clarification has somewhere to live.
        const created = await api.request<CaseRow>('/validation', {
          method: 'POST',
          body: JSON.stringify({ projectBranchId }),
        });
        caseId = (created as any).id;
        await loadCase();
      }
      const created = await api.request<QueryRow>('/validation-queries', {
        method: 'POST',
        body: JSON.stringify({
          validationCaseId: caseId,
          queryText: newQueryText.trim(),
          // Anchoring the question to a field lets the assayer jump straight to the disputed
          // value instead of hunting for it. Urgency tightens the SLA the worklist sorts by.
          targetField: newQueryField.trim() || undefined,
          slaHours: newQueryUrgent ? 2 : undefined,
        }),
      });
      setNewQueryText('');
      setNewQueryField('');
      setNewQueryUrgent(false);
      setShowNewQuery(false);
      await loadQueries(caseId!);
      setSelectedQuery((created as any).id);
    } catch (e) {
      setErr(userMessage(e));
    }
    setBusy(false);
  };

  /**
   * The field names the scanner actually read off this packet, offered as suggestions when the
   * clerk anchors a question to a field.
   *
   * "Field (optional)" was a bare text box. Anchoring the question is what lets the assayer jump
   * straight to the disputed value, but a clerk had to remember and re-type a field name with no
   * idea what spelling the system expects — so it was usually left blank, or typed differently
   * every time ("Gross wt", "gross weight", "GrossWeight"), which makes the same field unmatchable
   * across threads. The names are already on screen in "What the scanner read" a few lines above,
   * so the box now suggests exactly those, humanised the same way that list humanises them. A
   * datalist rather than a dropdown, because a clerk must still be able to ask about something the
   * scanner failed to read at all — which is a large share of what gets asked.
   */
  const fieldSuggestions = useMemo(() => {
    const r = validationCase?.ocrResult;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return [] as string[];
    return Object.keys(r as Record<string, unknown>).map(ocrFieldLabel);
  }, [validationCase]);

  const openCount = (queries ?? []).filter((q) => q.status !== 'RESOLVED').length;
  const status = validationCase?.status;
  const tone = status ? STATUS_TONE[status] ?? 'var(--text-muted)' : 'var(--text-muted)';
  const branchName = validationCase?.projectBranch?.branch?.name;
  const branchCode = validationCase?.projectBranch?.branch?.branchCode;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {confirmDialog}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button onClick={onBack} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <ArrowLeft size={14} /> Back to the board
        </button>
        {branchName && (
          <div style={{ fontSize: '13.5px', fontWeight: 700 }}>
            {branchName} <span style={{ fontFamily: 'monospace', fontWeight: 400, color: 'var(--text-muted)', fontSize: '12px' }}>{branchCode}</span>
          </div>
        )}
        {status && (
          <span style={{ fontSize: '11px', fontWeight: 700, color: tone, display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: tone }} />
            {validationStatusLabel(status)}
          </span>
        )}
        {validationCase?.id && (
          <button onClick={toggleTrail} className="btn btn-secondary"
            style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', width: 'auto' }}>
            <HistoryIcon size={13} /> {showTrail ? 'Hide history' : 'History'}
          </button>
        )}
      </div>

      {showTrail && (
        <section style={{ ...panel, padding: '12px 14px', maxHeight: '260px', overflowY: 'auto' }}>
          <div style={{ ...label, marginBottom: '8px' }}>Audit trail — every action on this packet and case</div>
          {trail === null && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>}
          {trail?.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Nothing has happened on this case yet. Every upload, edit, clarification and approval will be listed here as it happens.</div>}
          {trail?.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: '10px', padding: '6px 0', borderTop: i > 0 ? '1px solid var(--border-hair)' : 'none', fontSize: '12px', alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {new Date(t.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span style={{ fontWeight: 700 }}>{activityEventLabel(t.eventType)}</span>
              {/* The trail's from/to are this case's own validation statuses — the same
                  vocabulary as the header chip above, so it has to read the same way. */}
              {t.previousState && t.newState && t.previousState !== t.newState && (
                <span style={{ color: 'var(--text-secondary)' }}>{validationStatusLabel(t.previousState)} → {validationStatusLabel(t.newState)}</span>
              )}
              {t.actor && <span style={{ color: 'var(--accent)' }}>{t.actor}</span>}
              {t.remarks && <span style={{ color: 'var(--text-muted)', flexBasis: '100%', paddingLeft: '2px' }}>{t.remarks}</span>}
            </div>
          ))}
        </section>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: narrow ? '1fr' : 'minmax(0, 1.35fr) minmax(360px, 1fr)',
        gap: '12px',
        // Stacked, a single fixed viewport height would squash both panels; give
        // each its own workable height and let the page scroll instead.
        height: narrow ? 'auto' : 'calc(100vh - 190px)',
        minHeight: narrow ? 0 : '520px',
      }}>
        <section style={{ ...panel, minWidth: 0, ...(narrow ? { height: '70vh' } : null) }}>
          {!returnedDoc && docs !== null && (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <FileWarning size={24} style={{ opacity: 0.4 }} />
              <div style={{ fontSize: '13px', marginTop: '10px' }}>No returned PDF has been uploaded for this branch yet.</div>
            </div>
          )}
          {returnedDoc && !fileUrl && !err && (
            <div style={{ padding: '14px', display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              <Loader2 size={15} className="spin" /> Preparing document…
            </div>
          )}
          {err && !fileUrl && <div style={{ padding: '14px', color: 'var(--danger)', fontSize: '13px' }}>{err}</div>}
          {fileUrl && <PdfRegionViewer fileUrl={fileUrl} focus={focus} onCapture={setPending} />}
        </section>

        <section style={{ ...panel, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, ...(narrow ? { height: '75vh' } : null) }}>
          {/* Case decision — only present once a case exists, and only offered to
              the roles that make the call. */}
          {validationCase === undefined ? (
            <div style={{ padding: '14px' }}><Loader2 size={14} className="spin" /></div>
          ) : validationCase === null ? (
            <div style={{ padding: '11px 13px', fontSize: '12px', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)' }}>
              No review case yet — still being worked. Raising a clarification below opens one.
            </div>
          ) : (
            <div style={{ padding: '11px 13px', borderBottom: '1px solid var(--border-color)' }}>
              {validationCase.correctionNotes ? (
                <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '8px' }}>
                  <strong>Correction requested:</strong> {validationCase.correctionNotes}
                </div>
              ) : status === 'CORRECTION_REQUIRED' ? (
                // Bulk rework used to accept an empty note, so cases returned before that was
                // fixed carry no reason at all. Say so, rather than showing a blank panel that
                // leaves the operator guessing what to correct.
                <div style={{ fontSize: '12px', color: 'var(--danger)', marginBottom: '8px' }}>
                  <strong>Correction requested</strong> — no note was recorded. Ask the reviewer what needs changing.
                </div>
              ) : null}
              {validationCase.ocrResult && <OcrExtraction result={validationCase.ocrResult} />}
              {canReview && status !== 'SUBMITTED' && (
                <>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes (required if requesting a correction)"
                    rows={2}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '7px 9px', fontSize: '12px',
                      borderRadius: '7px', background: 'var(--bg-input)', color: 'inherit',
                      border: '1px solid var(--border-color)', resize: 'vertical', marginBottom: '8px',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {/*
                      Approve is only reachable from HUMAN_REVIEW (see VALIDATION_TRANSITIONS).
                      This used to render for every status except APPROVED, so a case sitting in
                      PENDING or CORRECTION_REQUIRED showed Approve as its only action and clicking
                      it always failed with a raw "Invalid Transition" — on a screen that offered
                      nothing else to do. The sibling "Request correction" below was already gated
                      this way; this now matches it.
                    */}
                    {status === 'HUMAN_REVIEW' && (
                      <button onClick={() => decide('APPROVED')} disabled={busy} className="btn btn-primary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Check size={12} /> Approve
                      </button>
                    )}
                    {/*
                      Earlier states have no decision to make here — say what moves the case on
                      instead of leaving the panel blank or, worse, offering a button that cannot work.
                    */}
                    {(status === 'PENDING' || status === 'ASSIGNED' || status === 'OCR_PROCESSING') && (
                      <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', alignSelf: 'center' }}>
                        Not in review yet — hand the packet back from the Packets board to send it for review.
                      </span>
                    )}
                    {status === 'CORRECTION_REQUIRED' && (
                      <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', alignSelf: 'center' }}>
                        Sent back for rework — hand the packet back from the Packets board once corrected.
                      </span>
                    )}
                    {(status === 'HUMAN_REVIEW') && (
                      <button onClick={() => decide('CORRECTION_REQUIRED')} disabled={busy || !notes.trim()} className="btn btn-secondary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)' }}>
                        <RotateCcw size={12} /> Request correction
                      </button>
                    )}
                    {status === 'APPROVED' && canSubmit && (
                      <button onClick={() => decide('SUBMITTED')} disabled={busy} className="btn btn-primary"
                        style={{ fontSize: '11.5px', padding: '6px 11px', display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--success)', borderColor: 'var(--success)' }}>
                        <SubmitIcon size={12} /> Submit to client
                      </button>
                    )}
                    {status === 'APPROVED' && !canSubmit && (
                      <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', alignSelf: 'center' }}>Approved — a manager submits to the client.</span>
                    )}
                  </div>
                </>
              )}
              {status === 'SUBMITTED' && (
                <div style={{ fontSize: '12px', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Check size={13} /> Sent to the client.
                </div>
              )}
            </div>
          )}

          {/* Clarifications Header */}
          <div style={{
            padding: '10px 14px', borderBottom: '1px solid var(--border-color)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '8px', flexWrap: 'wrap',
            background: 'var(--bg-surface-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
              <MessageSquare size={15} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Assayer Chat & Clarifications {openCount > 0 && <span style={{ color: 'var(--warning)', marginLeft: '4px' }}>({counted(openCount, 'still open', 'still open')})</span>}
              </span>
            </div>
            <button onClick={() => setShowNewQuery((v) => !v)} className="btn btn-primary"
              style={{ fontSize: '11px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600 }}>
              <MessageSquarePlus size={13} /> {showNewQuery ? 'Cancel' : 'Ask the assayer'}
            </button>
          </div>

          {showNewQuery && (
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <input
                value={newQueryText}
                onChange={(e) => setNewQueryText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') raiseQuery(); }}
                placeholder="Type your question for the assayer… e.g. Gross weight mismatch on row 3"
                style={{ padding: '8px 11px', fontSize: '12.5px', borderRadius: '8px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none' }}
              />
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  value={newQueryField}
                  onChange={(e) => setNewQueryField(e.target.value)}
                  list={fieldSuggestions.length ? 'ocr-field-suggestions' : undefined}
                  placeholder={fieldSuggestions.length
                    ? 'Which field? (optional) — pick one or type your own'
                    : 'Which field? (optional) — e.g. Gross weight'}
                  style={{ flex: '1 1 180px', padding: '7px 10px', fontSize: '12px', borderRadius: '8px', background: 'var(--bg-input)', color: 'inherit', border: '1px solid var(--border-color)', outline: 'none' }}
                />
                {fieldSuggestions.length > 0 && (
                  <datalist id="ocr-field-suggestions">
                    {fieldSuggestions.map((f) => <option key={f} value={f} />)}
                  </datalist>
                )}
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  {/* "(2h)" was the SLA in shorthand; say what the deadline actually is. */}
                  <input type="checkbox" checked={newQueryUrgent} onChange={(e) => setNewQueryUrgent(e.target.checked)} /> Urgent — answer needed within 2 hours
                </label>
                <button onClick={raiseQuery} disabled={busy || !newQueryText.trim()} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 14px', fontWeight: 600, marginLeft: 'auto' }}>
                  {busy ? <Loader2 size={13} className="spin" /> : 'Send the question'}
                </button>
              </div>
            </div>
          )}

          {err && (
            <div style={{ padding: '8px 14px', fontSize: '12px', color: 'var(--danger)', display: 'flex', gap: '6px', alignItems: 'center', background: 'rgba(239,68,68,0.1)' }}>
              <AlertTriangle size={13} /> {err}
            </div>
          )}

          {!selectedQuery ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {queries === null && <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '16px 0', textAlign: 'center' }}>Loading clarifications…</div>}
              {queries?.length === 0 && (
                <div style={{
                  padding: '24px 16px', textAlign: 'center', borderRadius: '10px',
                  background: 'var(--bg-surface-2)', border: '1px border-dashed var(--border-color)',
                  color: 'var(--text-muted)', fontSize: '12.5px',
                }}>
                  <MessageSquare size={24} style={{ opacity: 0.3, marginBottom: '8px' }} />
                  <div>No clarification threads for this branch.</div>
                  <div style={{ fontSize: '11.5px', marginTop: '4px', lineHeight: 1.5 }}>
                    When something on this packet is unclear, use "Ask the assayer" above. Your question
                    and their reply are kept here against this branch.
                  </div>
                </div>
              )}
              {queries?.map((q) => {
                const isResolved = q.status === 'RESOLVED';
                return (
                  <button
                    key={q.id}
                    onClick={() => setSelectedQuery(q.id)}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: '6px', width: '100%', textAlign: 'left',
                      padding: '12px 14px', borderRadius: '10px', cursor: 'pointer', fontSize: '13px',
                      background: isResolved ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                      border: `1px solid ${isResolved ? 'var(--border-color)' : 'var(--accent)'}`,
                      color: 'inherit', transition: 'all 0.15s ease',
                      boxShadow: isResolved ? 'none' : '0 2px 5px rgba(0,0,0,0.04)',
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, flex: 1, overflow: 'hidden' }}>
                        <MessageSquare size={14} style={{ color: isResolved ? 'var(--text-muted)' : 'var(--accent)', flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.queryText}</span>
                      </div>
                      <span style={{
                        fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '10px',
                        background: isResolved ? 'rgba(34,197,94,0.15)' : 'rgba(234,179,8,0.15)',
                        color: isResolved ? 'var(--success)' : 'var(--warning)',
                        flexShrink: 0, whiteSpace: 'nowrap',
                      }}>
                        {/*
                          Printed the raw enum: a thread chip read OPEN, RESPONDED or RESOLVED. A
                          clerk cannot tell from "RESPONDED" whether the assayer answered (their job
                          now) or we did (wait for the assayer) — which is the only thing the chip is
                          there to tell them. The shared label says whose move it is.
                        */}
                        {validationQueryStatusLabel(q.status)}
                      </span>
                    </div>
                    {q.targetField && (
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
                        Field: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{q.targetField}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)' }}>
                <button onClick={() => setSelectedQuery(null)} className="btn btn-secondary"
                  style={{ fontSize: '11.5px', padding: '4px 10px', display: 'inline-flex', alignItems: 'center', gap: '5px', fontWeight: 600 }}>
                  <ArrowLeft size={12} /> Back to all questions
                </button>
              </div>
              <ThreadPanel
                queryId={selectedQuery}
                status={queries?.find((q) => q.id === selectedQuery)?.status}
                pending={pending}
                onClearPending={() => setPending(null)}
                onFocusRegion={setFocus}
                onResolved={() => validationCase && loadQueries(validationCase.id)}
                onChanged={() => validationCase && loadQueries(validationCase.id)}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default CaseWorkspace;
