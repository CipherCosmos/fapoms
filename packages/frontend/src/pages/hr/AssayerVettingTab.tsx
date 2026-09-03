import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, Building2, Phone, FileCheck, AlertTriangle, Plus, Check, Paperclip, Trash2, Lock } from 'lucide-react';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand, HARD_COPY_LOCATIONS,
} from '@fapoms/shared';

import { api } from '../../services/api';
import { Select, Modal, useConfirm, useToast, AlertBanner, SkeletonList } from '../../components/ui';
import { card, label, Empty } from './hr-ui';
import { DataTable } from '../../components/ui';
import { looksLikeMask } from './assayer-shared';
import { fmtDate } from '../../utils/dates';
import { userMessage } from '../../services/errors';
import { counted } from '../../utils/plural';

/**
 * May we send this person out, and to whom.
 *
 * Four things answer that together and they used to be columns on one spreadsheet row: who
 * vouched for them, what the background check found, which banks accept them, and whether their
 * joining paperwork is actually in the building. Splitting them across four tabs would mean
 * asking one question four times, so they share this one.
 *
 * The order is the order the question is asked in. Vetting first, because an adverse finding
 * ends the conversation regardless of what the other three say. Then standing, which is per
 * client and is the operative answer for planning. References and paperwork last: they are how
 * the first two got their grounds.
 */

const VERDICT_LABELS: Record<string, string> = {
  [BackgroundCheckVerdict.CLEAR]: 'Clear',
  [BackgroundCheckVerdict.CRIMINAL_CASE]: 'Criminal case',
  [BackgroundCheckVerdict.CIVIL_CASE]: 'Civil case',
  [BackgroundCheckVerdict.ADVERSE_FINDING]: 'Adverse finding',
  [BackgroundCheckVerdict.NOT_CHECKED]: 'Not checked',
};

/**
 * A verdict is not a status badge; it is a decision about somebody's livelihood and access to a
 * vault. Only two colours are used — the ordinary one and the one that means stop — because a
 * five-colour scale invites reading "civil case" as merely worse than "clear" rather than as a
 * thing a person has to look at.
 */
const verdictTone = (v?: string | null): string =>
  v === BackgroundCheckVerdict.CRIMINAL_CASE || v === BackgroundCheckVerdict.ADVERSE_FINDING
    ? 'var(--danger)'
    : v === BackgroundCheckVerdict.CIVIL_CASE
      ? 'var(--warning)'
      : 'var(--text-primary)';

const RISK_LABELS: Record<string, string> = {
  [RiskGrade.LOW]: 'Low risk', [RiskGrade.MEDIUM]: 'Medium risk',
  [RiskGrade.HIGH]: 'High risk', [RiskGrade.VERY_HIGH]: 'Very high risk',
};

const CIBIL_LABELS: Record<string, string> = {
  [CibilBand.GOOD]: 'Good', [CibilBand.AVERAGE]: 'Average', [CibilBand.POOR]: 'Poor',
  [CibilBand.BAD]: 'Bad', [CibilBand.NO_CREDIT_HISTORY]: 'No credit history',
  [CibilBand.NOT_CHECKED]: 'Not checked', [CibilBand.CHECK_FAILED]: 'Check failed',
};

export const STANDING_LABELS: Record<string, string> = {
  [EmpanelmentStatus.ACTIVE]: 'Active',
  [EmpanelmentStatus.RECOMMENDED]: 'Recommended',
  [EmpanelmentStatus.NOT_RECOMMENDED]: 'Not recommended',
  [EmpanelmentStatus.DOCUMENTS_PENDING]: 'Documents pending',
  [EmpanelmentStatus.REJECTED]: 'Rejected',
  [EmpanelmentStatus.RESIGNED]: 'Resigned',
  [EmpanelmentStatus.TERMINATED]: 'Terminated',
};

/** Which standings mean "do not plan them for this client". */
export const BLOCKING_STANDINGS = new Set<string>([
  EmpanelmentStatus.NOT_RECOMMENDED, EmpanelmentStatus.REJECTED,
  EmpanelmentStatus.RESIGNED, EmpanelmentStatus.TERMINATED,
]);

interface Dossier {
  references: any[];
  empanelments: any[];
  backgroundChecks: any[];
  currentCheck: any | null;
  onboarding: any[];
  openIssues: any[];
}

const Section: React.FC<{
  title: string; icon: React.ElementType; hint?: string; action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon: Icon, hint, action, children }) => (
  <div style={{ ...card, marginBottom: '14px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: hint ? '4px' : '10px' }}>
      <Icon size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
      <div style={{ ...label, flex: 1 }}>{title}</div>
      {action}
    </div>
    {hint && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px' }}>{hint}</div>}
    {children}
  </div>
);

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '12.5px',
  background: 'var(--bg-surface)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: '7px', fontFamily: 'inherit',
};

const Field: React.FC<{ title: string; children: React.ReactNode; wide?: boolean }> = ({ title, children, wide }) => (
  <div style={{ flex: wide ? '1 1 100%' : '1 1 150px', minWidth: 0 }}>
    <div style={{ ...label, marginBottom: '5px' }}>{title}</div>
    {children}
  </div>
);

/** A yes/no cell where "we have not asked" and "no" are different answers. */
const yesNo = (v: boolean | null | undefined) =>
  v === true ? <span style={{ color: 'var(--success)' }}>Yes</span>
    : v === false ? <span style={{ color: 'var(--text-muted)' }}>No</span>
      : <span style={{ color: 'var(--text-muted)' }}>—</span>;

/**
 * What the Scan column says when there is no scan.
 *
 * A green "Yes" against `soft_copy_received` was the wrong answer on 10,977 rows: the old import
 * ticked that column straight from a spreadsheet, so it means "the sheet said a soft copy
 * existed", not "there is a file here". Shown as a plain "Yes" it read identically to a row with
 * a scan attached and made a whole roster look collected. This says which of the two it is, in
 * the amber the rest of the app uses for "somebody needs to do something", so the difference is
 * visible from across the table.
 */
const NoScan: React.FC<{ claimed: boolean | null | undefined }> = ({ claimed }) => (
  claimed === true ? (
    <span
      style={{ color: 'var(--warning)', fontWeight: 600 }}
      title="The old roster spreadsheet ticked this document as received, but no file was ever uploaded — so there is nothing here to look at or to check against the original. Upload the scan to close it."
    >
      Claimed on the old sheet — no scan
    </span>
  ) : yesNo(claimed)
);

/**
 * Nothing recorded is not the same as checked-and-fine, so an unverified document says so
 * rather than showing a blank the eye slides over.
 */
const VerificationChip: React.FC<{ status?: string | null }> = ({ status }) => {
  if (status === 'VERIFIED') return <span style={{ color: 'var(--success)' }}>Verified</span>;
  if (status === 'REJECTED') return <span style={{ color: 'var(--danger)' }}>Rejected</span>;
  return <span style={{ color: 'var(--text-muted)' }}>Not checked</span>;
};

/**
 * The attached scans for one document, as thumbnails you can open.
 *
 * The route needs an Authorization header, so a plain `<img src>` cannot fetch it — the bytes
 * come through `api.request` as a blob and become an object URL, the same way every other
 * protected file in this app is read. Revoked on unmount, or the tab leaks a copy of every
 * identity document somebody scrolls past.
 *
 * Everything is served as `application/octet-stream` with `nosniff`, so what renders as an image
 * here can never execute in the app's own origin. That is also why the type is guessed from the
 * key's extension rather than trusted from the response.
 */
const Attachments: React.FC<{
  documentId: string | null;
  filePaths: string[];
  canManage: boolean;
  onRemoved: () => void;
  /** Failures go to the tab's one banner, not to a toast of this component's own. */
  onError: (message: string) => void;
  /** Which document these scans belong to, so the delete button can name it. */
  documentLabel: string;
}> = ({ documentId, filePaths, canManage, onRemoved, onError, documentLabel }) => {
  const [urls, setUrls] = useState<(string | null)[]>([]);

  useEffect(() => {
    if (!documentId || filePaths.length === 0) { setUrls([]); return undefined; }
    let live = true;
    const made: string[] = [];
    Promise.all(filePaths.map((_, i) =>
      api.request<Blob>(`/assayers/document/${documentId}/file/${i}`, { raw: true })
        .then((b) => { const u = URL.createObjectURL(b); made.push(u); return u; })
        .catch(() => null),
    )).then((list) => { if (live) setUrls(list); });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [documentId, filePaths.join('|')]);

  const isImage = (key: string) => /\.(jpe?g|png|webp|heic|heif)$/i.test(key);

  const remove = async (index: number) => {
    if (!documentId) return;
    try {
      await api.request(`/assayers/document/${documentId}/file/${index}`, { method: 'DELETE' });
      onRemoved();
    } catch (e) { onError(userMessage(e)); }
  };

  if (filePaths.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      {filePaths.map((key, i) => {
        const url = urls[i];
        const name = key.split('/').pop() ?? 'file';
        return (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
            <a
              href={url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              title={name}
              style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: 'var(--primary)' }}
            >
              {url && isImage(key) ? (
                <img
                  src={url}
                  alt={name}
                  style={{
                    width: '34px', height: '34px', objectFit: 'cover', borderRadius: '5px',
                    border: '1px solid var(--border-color)', display: 'block',
                  }}
                />
              ) : (
                <span style={{ fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                  <Paperclip size={11} /> {url ? 'Open' : 'Loading…'}
                </span>
              )}
            </a>
            {canManage && (
              <button
                onClick={() => remove(i)}
                aria-label={`Remove this scan of ${documentLabel}`}
                title={`Remove this scan of ${documentLabel}`}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0 }}
              >
                <Trash2 size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
};

/**
 * Choose a file, in one click, with no dialog in between.
 *
 * A hidden input behind a label is the only way to style a file picker, and the value is cleared
 * after each pick so choosing the same file twice — a re-scan of the same page — still fires a
 * change event. Without that the second attempt silently does nothing.
 */
const UploadButton: React.FC<{
  requirement: string;
  onPick: (requirement: string, file: File) => void;
  /** Named per row so the control says which document it is about. */
  documentLabel: string;
}> = ({ requirement, onPick, documentLabel }) => (
  /*
    "Attach" is email vocabulary. What this does is put a scan or a photograph of a paper
    document onto the person's record, which is the whole point of the Documents tab and the
    thing 11,160 requirement rows are waiting for — and a clerk hunting for where to put the
    photocopy they are holding does not scan a table for the word "Attach".
  */
  <label
    style={{ color: 'var(--primary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
    title={`Upload a PDF or a photo of the ${documentLabel}`}
  >
    <Paperclip size={11} style={{ verticalAlign: '-1px' }} /> Upload scan
    <input
      type="file"
      accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
      style={{ display: 'none' }}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) onPick(requirement, file);
      }}
    />
  </label>
);

/**
 * How a referee knows the person.
 *
 * Free text here produced nothing usable — every one of the 1,983 imported references has this
 * blank — and free text is also how one relationship becomes "Ex-manager", "ex manager" and
 * "Former Manager". A short list covers what a reference actually is; anything else is a note,
 * not a relationship.
 */
const RELATIONSHIPS = [
  'Former manager', 'Former colleague', 'Current colleague', 'Client contact',
  'Friend', 'Neighbour', 'Relative',
] as const;

/** The office a signed original sits in, chosen rather than typed. */
const LocationPicker: React.FC<{ value: string | null; onChange: (v: string) => void }> = ({ value, onChange }) => (
  <select
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value)}
    style={{
      padding: '4px 7px', fontSize: '12px', background: 'var(--bg-surface)',
      color: value ? 'var(--text-primary)' : 'var(--text-muted)',
      border: '1px solid var(--border-color)', borderRadius: '6px', fontFamily: 'inherit',
    }}
  >
    <option value="">Not recorded</option>
    {HARD_COPY_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
  </select>
);

const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--primary)', fontSize: '12px', fontWeight: 600,
};

export const AssayerVettingTab: React.FC<{
  assayerId: string;
  canManage: boolean;
  /**
   * Which half to render.
   *
   * Both halves read the same dossier — one request answering "may we send this person out, and
   * to whom" — but they are looked for by different names. Somebody chasing a missing NDA goes
   * looking for "Documents"; nobody goes looking for it under "Vetting". They are two tabs over
   * one fetch rather than two fetches or one buried tab.
   */
  section: 'checks' | 'documents';
}> = ({ assayerId, canManage, section }) => {
  const [data, setData] = useState<Dossier | null>(null);
  /**
   * Everything on this tab that failed and wants a decision, in one strip at the top.
   *
   * There were two channels here for one screen: this state, which held only "the dossier would
   * not load", and fourteen `toast({ type: 'error' })` calls for every write — recording a
   * check, saving a standing, attaching a scan, verifying a document. A toast is right for "3
   * changes saved" and wrong for "that document was not attached": the operator is looking at
   * the table they just acted on, the toast appears in the far corner, and four seconds later
   * there is no evidence anything went wrong. Successes still toast; failures stay here until
   * they are read.
   */
  const [err, setErr] = useState<string | null>(null);
  const [clients, setClients] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [checkDraft, setCheckDraft] = useState<
    { verdict: string; riskGrade: string; cibilScore: string; cibilBand: string; checkedOn: string; findings: string } | null
  >(null);
  /**
   * The reference being added or corrected. `id` present = correcting an existing one.
   *
   * The tab could add a reference and stamp it as spoken-to, and nothing else — while
   * `PUT /assayers/:assayerId/reference/:id` and `DELETE /assayers/reference/:id` have existed
   * all along. So a name typed wrong, a phone number that turned out to be someone else's, or a
   * referee entered against the wrong person could only be added to, never fixed: the roster
   * import brought in 1,983 of these rows.
   */
  const [refDraft, setRefDraft] = useState<
    { id?: string; fullName: string; relationship: string; phone: string } | null
  >(null);
  const [idDraft, setIdDraft] = useState<
    { requirement: string; label: string; documentNumber: string; expiryDate: string } | null
  >(null);
  const [standing, setStandingModal] = useState<
    { clientId: string; clientName: string; status: string; statusReason: string } | null
  >(null);
  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    api.request<Dossier>(`/assayers/${assayerId}/dossier`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(userMessage(e)); });
    return () => { cancelled = true; };
  }, [assayerId, reloadKey]);

  // The client list is needed only to offer standings that do not exist yet, so it is fetched
  // alongside rather than blocking the dossier.
  useEffect(() => {
    let cancelled = false;
    api.request<any>('/clients?limit=200')
      .then((d) => {
        const rows = Array.isArray(d) ? d : (d?.items ?? d?.data ?? []);
        if (!cancelled) setClients(rows.map((c: any) => ({ id: c.id, name: c.name })));
      })
      .catch(() => { /* the existing standings still render; only "add" is unavailable */ });
    return () => { cancelled = true; };
  }, []);

  const reload = () => setReloadKey((k) => k + 1);

  const paperwork = useMemo(() => {
    const rows = data?.onboarding ?? [];
    // "In hand" means the hard copy is actually in the building. A soft copy is progress, not
    // completion — the file this tracks is a physical one.
    const inHand = rows.filter((r) => r.hardCopyReceived === true).length;
    /**
     * A REQUIREMENT COUNTS AS HAVING A SOFT COPY ONLY WHEN A FILE IS ACTUALLY ON IT.
     *
     * `soft_copy_received` is ticked on 10,977 document rows that carry zero files: the old
     * roster import copied a spreadsheet column of ticks, and a tick in a spreadsheet is
     * somebody's claim that a scan existed somewhere, not a scan. Counting those as "soft copy
     * received" told HR the collection was nearly done when in fact not one file had ever been
     * uploaded, and it is the single reason nobody noticed for as long as they did.
     *
     * So the count is split. `withScan` is evidence — a file is attached and can be opened.
     * `claimedNoScan` is the spreadsheet's claim with nothing behind it, reported separately and
     * in the words of what it actually is. The flag itself is NOT reset: it truthfully records
     * what the sheet said, and wiping 10,977 rows would destroy the only trace of who claimed
     * what.
     */
    const withScan = rows.filter((r) => (r.filePaths ?? []).length > 0).length;
    const claimedNoScan = rows.filter((r) => (r.filePaths ?? []).length === 0 && r.softCopyReceived === true).length;
    // The server decides which are identity documents — one definition, in @fapoms/shared.
    return {
      rows,
      identity: rows.filter((r) => r.identity),
      joining: rows.filter((r) => !r.identity),
      inHand, withScan, claimedNoScan, total: rows.length,
    };
  }, [data]);

  const blocking = useMemo(
    () => (data?.empanelments ?? []).filter((e) => BLOCKING_STANDINGS.has(e.status)),
    [data],
  );

  const saveStanding = async () => {
    if (!standing) return;
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/empanelment/${standing.clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: standing.status, statusReason: standing.statusReason || undefined }),
      });
      toast({
        type: 'success',
        title: 'Standing recorded',
        message: `${standing.clientName} — ${STANDING_LABELS[standing.status] ?? standing.status}.`,
      });
      setStandingModal(null);
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveCheck = async () => {
    if (!checkDraft) return;
    setBusy(true);
    try {
      const score = Number(checkDraft.cibilScore.replace(/[^\d]/g, ''));
      await api.request(`/assayers/${assayerId}/background-check`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: checkDraft.verdict,
          riskGrade: checkDraft.riskGrade || undefined,
          cibilBand: checkDraft.cibilBand || undefined,
          cibilScore: Number.isFinite(score) && score > 0 ? score : undefined,
          checkedOn: checkDraft.checkedOn || undefined,
          findings: checkDraft.findings || undefined,
        }),
      });
      toast({ type: 'success', title: 'Check recorded', message: 'It is now the operative one; the previous check is kept below it.' });
      setCheckDraft(null);
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveReference = async () => {
    if (!refDraft) return;
    if (!refDraft.fullName.trim()) {
      setErr('A reference needs a name.');
      return;
    }
    const editingExisting = !!refDraft.id;
    setBusy(true);
    setErr(null);
    try {
      await api.request(
        editingExisting
          ? `/assayers/${assayerId}/reference/${refDraft.id}`
          : `/assayers/${assayerId}/reference`,
        {
          method: editingExisting ? 'PUT' : 'POST',
          body: JSON.stringify({
            fullName: refDraft.fullName.trim(),
            // `null`, not `undefined`: the server keeps the stored value when a key is absent
            // (`dto.phone ?? row.phone`), so an emptied box would silently put the old number
            // back — which is exactly the correction somebody opens this form to make.
            relationship: refDraft.relationship || null,
            phone: refDraft.phone.trim() || null,
          }),
        },
      );
      toast({
        type: 'success',
        title: editingExisting ? 'Reference updated' : 'Reference added',
        message: editingExisting
          ? `${refDraft.fullName.trim()} corrected.`
          : `${refDraft.fullName.trim()} is on file. Nobody has rung them yet.`,
      });
      setRefDraft(null);
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /**
   * Removing a reference, asked about first and named in the question.
   *
   * Deleting a referee removes the record that somebody vouched for this person — including,
   * where it was already stamped, the record that a call was actually made. That is evidence in
   * a vetting file, so the dialog says what goes with it rather than asking "Are you sure?".
   */
  const removeReference = async (ref: any) => {
    const ok = await confirm({
      title: `Remove ${ref.fullName} as a reference?`,
      message: ref.checkedAt
        ? `${ref.fullName} was recorded as spoken to on ${fmtDate(ref.checkedAt)}. Removing them takes `
          + 'that record of the call away with them.'
        : `${ref.fullName} is taken off this person's vetting file. Nothing else changes.`,
      confirmLabel: 'Remove reference',
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await api.request(`/assayers/reference/${ref.id}`, { method: 'DELETE' });
      toast({ type: 'success', title: 'Reference removed', message: `${ref.fullName} is no longer on file.` });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveIdentity = async () => {
    if (!idDraft) return;
    /**
     * A document number that is still the mask is not an edit.
     *
     * The dossier masks `documentNumber` the same way the record masks the PAN and Aadhaar it
     * writes through to (`NUMBER_LIVES_ON_THE_PERSON` in the backend), so anything filled from
     * the row rather than typed from the card is `******234F`. The box is opened empty for that
     * reason; this catches the case where somebody pastes a mask back in, which the server would
     * refuse in language about revealing a field they never saw a reveal control for.
     */
    if (looksLikeMask(idDraft.documentNumber)) {
      setErr(`That is the covered form of the ${idDraft.label.toLowerCase()} number, not the number. `
        + 'Type it from the document itself, or press Cancel to leave the stored one alone.');
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${idDraft.requirement}`, {
        method: 'PUT',
        body: JSON.stringify({
          documentNumber: idDraft.documentNumber.trim(),
          expiryDate: idDraft.expiryDate || null,
        }),
      });
      setIdDraft(null);
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const verify = async (doc: any, verdict: string) => {
    const ok = await confirm({
      title: `Confirm ${doc.label} against the original?`,
      message: `This records that you checked ${doc.documentNumber} against the document itself. `
        + 'A client\u2019s branch relies on it to admit this person to a vault.',
      confirmLabel: 'Yes, I checked it',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST', body: JSON.stringify({ verdict }),
      });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /**
   * Attaching the scan also records that the soft copy arrived — the file on the record *is* the
   * soft copy, and asking a clerk to tick a box next to a document they just uploaded is asking
   * them to state something the screen can already see.
   */
  const attach = async (requirement: string, file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      await api.request(`/assayers/${assayerId}/document/${requirement}/file`, {
        method: 'POST', body: form,
      });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /** Where the signed original is kept. A picked office, never a typed one — see the migration. */
  const setWhere = async (requirement: string, hardCopyLocation: string) => {
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${requirement}`, {
        method: 'PUT', body: JSON.stringify({ hardCopyLocation }),
      });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const togglePaperwork = async (requirement: string, field: 'softCopyReceived' | 'hardCopyReceived', value: boolean) => {
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${requirement}`, {
        method: 'PUT', body: JSON.stringify({ [field]: value }),
      });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const markChecked = async (ref: any) => {
    const ok = await confirm({
      title: `Record that ${ref.fullName} was spoken to?`,
      message: 'This stamps the reference with your name and today’s date. It says the call actually happened.',
      confirmLabel: 'Yes, I spoke to them',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.request(`/assayers/reference/${ref.id}/checked`, { method: 'POST', body: JSON.stringify({}) });
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /*
    A failed write no longer takes the whole tab away.

    `if (err) return <the error>` was right while `err` only ever meant "the dossier would not
    load". Now that every write reports here, blanking the page on a failed upload would throw
    away the table the operator is working in. The banner sits above the content; only a dossier
    that never arrived leaves nothing to show under it.
  */
  const errorBanner = <AlertBanner type="error" message={err} onClose={() => setErr(null)} style={{ marginBottom: '14px' }} />;
  if (!data) {
    return (
      <div>
        {errorBanner}
        {/* Was the word "Loading…" in the middle of an empty card. */}
        {!err && <SkeletonList rows={3} height={92} />}
      </div>
    );
  }

  const check = data.currentCheck;
  const unstanded = clients.filter((c) => !data.empanelments.some((e) => e.clientId === c.id));

  return (
    <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
      {confirmDialog}
      {errorBanner}

      {standing && (
        <Modal
          open
          onClose={() => setStandingModal(null)}
          title={`Standing with ${standing.clientName}`}
          width={480}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
              This decides whether {standing.clientName} will accept this person on their branches.
              It says nothing about any other client.
            </div>
            <div>
              <div style={{ ...label, marginBottom: '6px' }}>Standing</div>
              <Select
                value={standing.status}
                onChange={(v) => setStandingModal({ ...standing, status: String(v) })}
                options={Object.values(EmpanelmentStatus).map((v) => ({
                  value: v, label: STANDING_LABELS[v] ?? v,
                }))}
              />
            </div>
            <div>
              <div style={{ ...label, marginBottom: '6px' }}>Why (optional)</div>
              <textarea
                value={standing.statusReason}
                onChange={(e) => setStandingModal({ ...standing, statusReason: e.target.value })}
                rows={3}
                placeholder={BLOCKING_STANDINGS.has(standing.status)
                  ? 'What was the reason? This is the record of why they are not being sent.'
                  : 'Anything worth recording alongside this decision.'}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: '13px', resize: 'vertical',
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: '1px solid var(--border-color)', borderRadius: '8px', fontFamily: 'inherit',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button onClick={() => setStandingModal(null)} style={{ ...linkButton, color: 'var(--text-muted)' }}>
                Cancel
              </button>
              <button
                onClick={saveStanding}
                disabled={busy}
                style={{
                  background: 'var(--primary)', color: 'var(--on-accent)', border: 'none', borderRadius: '8px',
                  padding: '8px 16px', fontSize: '13px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
                }}
              >
                Save standing
              </button>
            </div>
          </div>
        </Modal>
      )}

      {data.openIssues.length > 0 && (
        <div style={{ ...card, marginBottom: '14px', borderColor: 'var(--warning)' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>
                {counted(data.openIssues.length, 'cell')} from the roster import could not be read for this person.
              </strong>
              <div style={{ marginTop: '6px' }}>
                {data.openIssues.map((i) => (
                  <div key={i.id} style={{ marginBottom: '3px' }}>
                    <code style={{ fontSize: '12px' }}>{i.sourceColumn}</code>{' — '}
                    {i.reason} Original text: “{i.rawValue}”.
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {section === 'checks' && (
        <>
      <Section
        title="Vetting"
        icon={check && verdictTone(check.verdict) === 'var(--danger)' ? ShieldAlert : ShieldCheck}
        hint="The most recent check is the operative one. Earlier checks are kept below it, because a picture that changed is the reason to look at a second one."
        action={canManage && !checkDraft ? (
          <button style={linkButton} onClick={() => setCheckDraft({
            verdict: BackgroundCheckVerdict.CLEAR, riskGrade: '', cibilScore: '',
            cibilBand: '', checkedOn: '', findings: '',
          })}>
            <Plus size={11} style={{ verticalAlign: '-1px' }} /> Record a check
          </button>
        ) : undefined}
      >
        {checkDraft && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--border-hair)' }}>
            <Field title="Verdict">
              <Select
                value={checkDraft.verdict}
                onChange={(v) => setCheckDraft({ ...checkDraft, verdict: String(v) })}
                options={Object.values(BackgroundCheckVerdict).map((v) => ({ value: v, label: VERDICT_LABELS[v] ?? v }))}
              />
            </Field>
            <Field title="Risk">
              <Select
                value={checkDraft.riskGrade}
                onChange={(v) => setCheckDraft({ ...checkDraft, riskGrade: String(v) })}
                options={[{ value: '', label: 'Not graded' }, ...Object.values(RiskGrade).map((v) => ({ value: v, label: RISK_LABELS[v] ?? v }))]}
              />
            </Field>
            <Field title="Credit band">
              <Select
                value={checkDraft.cibilBand}
                onChange={(v) => setCheckDraft({ ...checkDraft, cibilBand: String(v) })}
                options={[{ value: '', label: 'Not recorded' }, ...Object.values(CibilBand).map((v) => ({ value: v, label: CIBIL_LABELS[v] ?? v }))]}
              />
            </Field>
            <Field title="Credit score">
              <input style={inputStyle} inputMode="numeric" placeholder="e.g. 747"
                value={checkDraft.cibilScore}
                onChange={(e) => setCheckDraft({ ...checkDraft, cibilScore: e.target.value })} />
            </Field>
            <Field title="Checked on">
              <input style={inputStyle} type="date"
                value={checkDraft.checkedOn}
                onChange={(e) => setCheckDraft({ ...checkDraft, checkedOn: e.target.value })} />
            </Field>
            <Field title="Findings" wide>
              <input style={inputStyle}
                placeholder="What the check actually turned up. Leave empty if it turned up nothing."
                value={checkDraft.findings}
                onChange={(e) => setCheckDraft({ ...checkDraft, findings: e.target.value })} />
            </Field>
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => setCheckDraft(null)}>Cancel</button>
              <button onClick={saveCheck} disabled={busy} style={{
                background: 'var(--primary)', color: 'var(--on-accent)', border: 'none', borderRadius: '7px',
                padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>Record check</button>
            </div>
          </div>
        )}
        {!check ? (
          <Empty>No background check has been recorded.</Empty>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '18px', marginBottom: data.backgroundChecks.length > 1 ? '12px' : 0 }}>
            <div>
              <div style={label}>Verdict</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: verdictTone(check.verdict) }}>
                {VERDICT_LABELS[check.verdict] ?? check.verdict}
              </div>
            </div>
            {check.riskGrade && (
              <div><div style={label}>Risk</div><div style={{ fontSize: '13px' }}>{RISK_LABELS[check.riskGrade] ?? check.riskGrade}</div></div>
            )}
            {check.cibilBand && (
              <div>
                <div style={label}>Credit</div>
                <div style={{ fontSize: '13px' }}>
                  {CIBIL_LABELS[check.cibilBand] ?? check.cibilBand}
                  {check.cibilScore ? ` (${check.cibilScore})` : ''}
                </div>
              </div>
            )}
            <div><div style={label}>Checked</div><div style={{ fontSize: '13px' }}>{fmtDate(check.checkedOn) || '—'}</div></div>
            {check.findings && (
              <div style={{ flexBasis: '100%' }}>
                <div style={label}>Findings</div>
                <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{check.findings}</div>
              </div>
            )}
          </div>
        )}
        {data.backgroundChecks.length > 1 && (
          <DataTable
            density="compact"
            minWidth={false}
            rows={data.backgroundChecks.slice(1)}
            rowKey={(c) => c.id}
            columns={[
              { key: 'date', header: 'Date', render: (c) => <>{fmtDate(c.checkedOn) || '—'}</> },
              {
                key: 'verdict',
                header: 'Verdict',
                render: (c) => <span style={{ color: verdictTone(c.verdict) }}>{VERDICT_LABELS[c.verdict] ?? c.verdict}</span>,
              },
              { key: 'risk', header: 'Risk', render: (c) => <>{c.riskGrade ? (RISK_LABELS[c.riskGrade] ?? c.riskGrade) : '—'}</> },
              // Free prose written by whoever did the check — the one column here that is a
              // paragraph rather than a value, so it wraps instead of stretching the table.
              { key: 'findings', header: 'Findings', wrap: true, render: (c) => <>{c.findings || '—'}</> },
            ]}
          />
        )}
        {/*
          SAY THAT THERE IS NO EDIT BUTTON, RATHER THAN LEAVING PEOPLE TO HUNT FOR ONE.

          Every other list on this tab now has Change and Remove beside its rows, and this one
          deliberately does not: a background check is a dated statement of what somebody found
          when they looked, and a file where the finding can be quietly rewritten afterwards is
          worth nothing to the client whose vault this person walks into. Correcting one means
          recording a newer check, which is what the section's own first line describes. Without
          this sentence the absence reads as a missing feature, and somebody eventually builds
          it.
        */}
        {check && (
          <div style={{
            marginTop: '12px', display: 'flex', gap: '7px', alignItems: 'flex-start',
            fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5,
          }}>
            <Lock size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              Checks cannot be edited or deleted — each one is the record of what was found on the
              day it was done. If this is wrong or out of date, record a new check: it becomes the
              operative one and this drops into the list above.
            </span>
          </div>
        )}
      </Section>

      <Section
        title="Client standing"
        icon={Building2}
        hint="Whether each bank accepts this person. One answer per client — being active for one says nothing about another."
      >
        {data.empanelments.length === 0 ? (
          <Empty>No client standing has been recorded.</Empty>
        ) : (
          /*
            The Change column is one entry filtered out rather than a second header array. It used
            to be `head={canManage ? [...5] : [...4]}` at the top and a `cells.push(...)` twenty
            lines below: two halves of one column, kept in the same order by hand.
          */
          <DataTable
            density="compact"
            minWidth={false}
            rows={data.empanelments}
            rowKey={(e) => e.id}
            columns={[
              { key: 'client', header: 'Client', render: (e) => <>{e.client?.name ?? '—'}</> },
              {
                key: 'standing',
                header: 'Standing',
                render: (e) => (
                  <span style={{ fontWeight: 600, color: BLOCKING_STANDINGS.has(e.status) ? 'var(--danger)' : 'var(--text-primary)' }}>
                    {STANDING_LABELS[e.status] ?? e.status}
                  </span>
                ),
              },
              { key: 'decided', header: 'Decided', render: (e) => <>{fmtDate(e.decidedAt) || '—'}</> },
              { key: 'why', header: 'Why', wrap: true, render: (e) => <>{e.statusReason || e.documentsOutstanding || '—'}</> },
              ...(canManage ? [{
                key: 'act',
                header: '',
                render: (e: typeof data.empanelments[number]) => (
                  <button style={linkButton} onClick={() => setStandingModal({ clientId: e.clientId, clientName: e.client?.name ?? 'this client', status: e.status, statusReason: e.statusReason ?? '' })}>
                    Change
                  </button>
                ),
              }] : []),
            ]}
          />
        )}
        {canManage && unstanded.length > 0 && (
          <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No standing recorded for:</span>
            {unstanded.map((c) => (
              <button key={c.id} style={linkButton} onClick={() => setStandingModal({ clientId: c.id, clientName: c.name, status: EmpanelmentStatus.RECOMMENDED, statusReason: '' })}>
                <Plus size={11} style={{ verticalAlign: '-1px' }} /> {c.name}
              </button>
            ))}
          </div>
        )}
        {blocking.length > 0 && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--danger)' }}>
            Not to be planned for {blocking.map((e) => e.client?.name).filter(Boolean).join(', ')}.
          </div>
        )}
      </Section>

      <Section
        title="References"
        icon={Phone}
        hint="Who vouched for them, and whether anybody actually rang."
        action={canManage && !refDraft ? (
          <button style={linkButton} onClick={() => setRefDraft({ fullName: '', relationship: '', phone: '' })}>
            <Plus size={11} style={{ verticalAlign: '-1px' }} /> Add reference
          </button>
        ) : undefined}
      >
        {refDraft && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px', paddingBottom: '14px', borderBottom: '1px solid var(--border-hair)' }}>
            <Field title="Name">
              <input style={inputStyle} autoFocus value={refDraft.fullName}
                onChange={(e) => setRefDraft({ ...refDraft, fullName: e.target.value })} />
            </Field>
            <Field title="Relationship">
              <Select
                value={refDraft.relationship}
                onChange={(v) => setRefDraft({ ...refDraft, relationship: String(v) })}
                options={[{ value: '', label: 'Not recorded' }, ...RELATIONSHIPS.map((r) => ({ value: r, label: r }))]}
              />
            </Field>
            <Field title="Phone">
              <input style={inputStyle} inputMode="tel" value={refDraft.phone}
                onChange={(e) => setRefDraft({ ...refDraft, phone: e.target.value })} />
            </Field>
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => setRefDraft(null)}>Cancel</button>
              <button onClick={saveReference} disabled={busy} style={{
                background: 'var(--primary)', color: 'var(--on-accent)', border: 'none', borderRadius: '7px',
                padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>{refDraft.id ? 'Save changes' : 'Add reference'}</button>
            </div>
          </div>
        )}
        {data.references.length === 0 ? (
          <Empty>No references are on file.</Empty>
        ) : (
          <DataTable
            density="compact"
            minWidth={false}
            rows={data.references}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', header: 'Name', render: (r) => <>{r.fullName}</> },
              { key: 'rel', header: 'Relationship', render: (r) => <>{r.relationship || '—'}</> },
              { key: 'phone', header: 'Phone', render: (r) => <>{r.phone || '—'}</> },
              {
                key: 'checked',
                header: 'Spoken to',
                render: (r) => (r.checkedAt
                  ? <span style={{ color: 'var(--success)' }}><Check size={12} style={{ verticalAlign: '-2px' }} /> {fmtDate(r.checkedAt)}</span>
                  : <span style={{ color: 'var(--text-muted)' }}>Not yet</span>),
              },
              ...(canManage ? [{
                key: 'act',
                header: '',
                /*
                  Three controls where there used to be one, because the backend has had all three
                  since the vetting work landed and this table offered only "Record call". A
                  misspelt name or somebody else's phone number could be added and never corrected
                  — on 1,983 imported rows, that is the common case, not the edge one. "Record
                  call" stays first: it is the action, and correcting the row is the thing you do
                  on the way to it.
                */
                render: (r: typeof data.references[number]) => (
                  <div style={{ display: 'flex', gap: '12px' }}>
                    {r.checkedAt
                      ? <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Called</span>
                      : <button style={linkButton} onClick={() => markChecked(r)}>Record call</button>}
                    <button
                      style={linkButton}
                      onClick={() => setRefDraft({
                        id: r.id,
                        fullName: r.fullName ?? '',
                        relationship: r.relationship ?? '',
                        phone: r.phone ?? '',
                      })}
                    >
                      Change
                    </button>
                    <button style={{ ...linkButton, color: 'var(--danger)' }} onClick={() => removeReference(r)}>
                      Remove
                    </button>
                  </div>
                ),
              }] : []),
            ]}
          />
        )}
      </Section>
        </>
      )}

      {section === 'documents' && (
      <Section
        title="Documents"
        icon={FileCheck}
        hint={
          `${paperwork.withScan} of ${paperwork.total} have a scan on file; ${paperwork.inHand} of ${paperwork.total} have the signed original in hand.`
          + (paperwork.claimedNoScan
            ? ` ${counted(paperwork.claimedNoScan, 'other was', 'others were')} ticked as received on the old roster sheet with no file attached — those still need collecting.`
            : '')
        }
      >
        {/*
          Identity documents first, and separately.

          They are the ones a client's branch asks for before letting somebody near a vault, so
          they carry a number, an expiry and a verification. The rest is paperwork that either
          arrived or did not. Showing one table with four mostly-empty columns taught people to
          ignore the columns; showing an expiry box against a code-of-conduct letter taught them
          to ignore the expiry.
        */}
        <div style={{ ...label, marginBottom: '8px' }}>Identity</div>
        <DataTable
          density="compact"
          minWidth={false}
          rows={paperwork.identity}
          rowKey={(d) => d.requirement}
          columns={[
            { key: 'doc', header: 'Document', render: (d) => <>{d.label}</> },
            {
              key: 'number',
              header: 'Number',
              render: (d) => (d.documentNumber
                ? <code style={{ fontSize: '12px' }}>{d.documentNumber}</code>
                : <span style={{ color: 'var(--text-muted)' }}>—</span>),
            },
            {
              key: 'expires',
              header: 'Expires',
              render: (d) => (d.expiryDate ? <>{fmtDate(d.expiryDate)}</> : <span style={{ color: 'var(--text-muted)' }}>—</span>),
            },
            { key: 'checked', header: 'Checked', render: (d) => <VerificationChip status={d.verificationStatus} /> },
            {
              key: 'scan',
              header: 'Scan',
              render: (d) => (
                <Attachments documentId={d.id} filePaths={d.filePaths ?? []} canManage={canManage} onRemoved={reload} onError={setErr} documentLabel={d.label} />
              ),
            },
            ...(canManage ? [{
              key: 'act',
              header: '',
              render: (d: typeof paperwork.identity[number]) => (
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button style={linkButton} onClick={() => setIdDraft({
                    requirement: d.requirement, label: d.label,
                    // Empty, never the stored value: what the row holds is a mask (see
                    // `saveIdentity`), and a box opening on `******234F` invites a one-character
                    // correction that destroys the real number on the person's record.
                    documentNumber: '',
                    expiryDate: d.expiryDate ? String(d.expiryDate).slice(0, 10) : '',
                  })}>
                    {/* "Edit" promised the stored number in the box. It cannot be there — it is
                        masked — so the button says what actually happens: you type a new one. */}
                    {d.documentNumber ? 'Replace number' : 'Add number'}
                  </button>
                  {d.id && d.documentNumber && d.verificationStatus !== 'VERIFIED' && (
                    <button style={linkButton} onClick={() => verify(d, 'VERIFIED')}>Verify</button>
                  )}
                  <UploadButton requirement={d.requirement} onPick={attach} documentLabel={d.label} />
                </div>
              ),
            }] : []),
          ]}
        />

        {idDraft && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-hair)' }}>
            <Field title={`${idDraft.label} number`}>
              <input style={inputStyle} autoFocus value={idDraft.documentNumber}
                onChange={(e) => setIdDraft({ ...idDraft, documentNumber: e.target.value })} />
            </Field>
            <Field title="Expires">
              <input style={inputStyle} type="date" value={idDraft.expiryDate}
                onChange={(e) => setIdDraft({ ...idDraft, expiryDate: e.target.value })} />
            </Field>
            <div style={{ flexBasis: '100%', display: 'flex', justifyContent: 'flex-end', gap: '10px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginRight: 'auto', maxWidth: '52ch', lineHeight: 1.5 }}>
                Type the number from the document itself — the stored one is covered on screen, so
                the box starts empty. Saving replaces it and clears any verification, because
                somebody checked the old number against the original.
              </span>
              <button style={{ ...linkButton, color: 'var(--text-muted)' }} onClick={() => setIdDraft(null)}>Cancel</button>
              <button onClick={saveIdentity} disabled={busy} style={{
                background: 'var(--primary)', color: 'var(--on-accent)', border: 'none', borderRadius: '7px',
                padding: '7px 14px', fontSize: '12.5px', fontWeight: 600, cursor: busy ? 'default' : 'pointer',
              }}>Save</button>
            </div>
          </div>
        )}

        <div style={{ ...label, margin: '18px 0 8px' }}>Joining paperwork</div>
        <DataTable
          density="compact"
          minWidth={false}
          rows={paperwork.joining}
          rowKey={(d) => d.requirement}
          columns={[
            { key: 'doc', header: 'Document', render: (d) => <>{d.label}</> },
            {
              key: 'scan',
              header: 'Scan',
              // The scan itself where there is one; the tick only where somebody said a copy
              // arrived without attaching it. A column that can show the document should.
              render: (d) => ((d.filePaths ?? []).length > 0
                ? <Attachments documentId={d.id} filePaths={d.filePaths} canManage={canManage} onRemoved={reload} onError={setErr} documentLabel={d.label} />
                : <NoScan claimed={d.softCopyReceived} />),
            },
            { key: 'hard', header: 'Hard copy', render: (d) => <>{yesNo(d.hardCopyReceived)}</> },
            {
              key: 'where',
              header: 'Where',
              render: (d) => (canManage
                ? <LocationPicker value={d.hardCopyLocation} onChange={(v) => setWhere(d.requirement, v)} />
                : <>{d.hardCopyLocation || '—'}</>),
            },
            ...(canManage ? [{
              key: 'act',
              header: '',
              render: (d: typeof paperwork.joining[number]) => (
                <div style={{ display: 'flex', gap: '10px' }}>
                  <UploadButton requirement={d.requirement} onPick={attach} documentLabel={d.label} />
                  {/*
                    "Original in" / "Original out" is filing-room shorthand for a toggle: it does
                    not say what pressing it records, and the two read as a pair of opposite
                    actions rather than as one switch. What it actually tracks is whether the
                    signed paper is in the office.
                  */}
                  <button
                    style={linkButton}
                    onClick={() => togglePaperwork(d.requirement, 'hardCopyReceived', d.hardCopyReceived !== true)}
                    title={d.hardCopyReceived === true
                      ? `Record that the signed ${d.label} has left the office`
                      : `Record that the signed ${d.label} is now in the office`}
                  >
                    {d.hardCopyReceived === true ? 'Signed paper has gone out' : 'Signed paper is here'}
                  </button>
                </div>
              ),
            }] : []),
          ]}
        />
      </Section>
      )}
    </div>
  );
};
