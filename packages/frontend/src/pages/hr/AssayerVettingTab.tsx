import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, Building2, Phone, FileCheck, Plus, Check, Paperclip, Trash2, Lock } from 'lucide-react';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand, HARD_COPY_LOCATIONS,
  onboardingNextStep, standingAllowsPlanning,
} from '@fapoms/shared';

import { api } from '../../services/api';
import { Select, useConfirm, useToast, AlertBanner, SkeletonList, DataTable } from '../../components/ui';
import {
  label, Empty, Section, Notice, Lede, LinkButton, RowActions, Field, fieldInput, Editor,
} from './hr-ui';
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
  /*
    The eighth value. This map had seven entries for an eight-value enum, and every render site
    reads `STANDING_LABELS[status] ?? status` — so the one standing nobody had written a word for
    printed the literal `INACTIVE` at an HR clerk. `assayer.service.ts` writes it, so the row was
    always reachable; there simply are none today.
  */
  [EmpanelmentStatus.INACTIVE]: 'Empanelled before, dormant now',
};

/**
 * A standing that is somebody's decision not to send this person.
 *
 * This is NOT the same question as "can the planner offer them work" — that one is
 * `standingAllowsPlanning`, and it lives in @fapoms/shared beside the gate that enforces it.
 * This set exists for the second question the first cannot answer: *why* not, and therefore what
 * the operator does next. A refusal needs a conversation with the client; documents pending needs
 * paperwork; dormant needs reactivating. Same outcome for planning, three different next moves.
 */
const REFUSED_STANDINGS = new Set<string>([
  EmpanelmentStatus.NOT_RECOMMENDED, EmpanelmentStatus.REJECTED,
  EmpanelmentStatus.RESIGNED, EmpanelmentStatus.TERMINATED,
]);

export type StandingStance = 'plannable' | 'refused' | 'notReady';

/**
 * Where a standing leaves this person for one client, in the three states an operator acts on.
 *
 * There used to be a `BLOCKING_STANDINGS` set here — the four obvious negatives — and both this
 * tab and the record read it. It disagreed with the planner. `ClientEligibilityFilter` admits
 * **only** ACTIVE and RECOMMENDED, so DOCUMENTS_PENDING and INACTIVE are passed over on every
 * planning run; this screen rendered them in ordinary text and left them out of its "not to be
 * planned for" line, telling a vetting operator that somebody waiting on paperwork was fine while
 * the planner silently skipped them.
 *
 * The plannable/not-plannable half is now `standingAllowsPlanning` from @fapoms/shared — the same
 * function the engine calls, so the desk and the gate cannot drift apart again. Only the
 * refused/not-ready distinction is decided here, because only the screens need it.
 *
 * Three states and not five: the tab argues elsewhere against a colour scale that invites reading
 * one verdict as merely worse than another, and this is not that. These three are different
 * *actions*, and the record's standing chips have distinguished them by colour all along — the
 * bug was that two of the states were being sorted into the wrong one of the three.
 */
export const standingStance = (status?: string | null): StandingStance => {
  if (standingAllowsPlanning(status)) return 'plannable';
  return REFUSED_STANDINGS.has(status ?? '') ? 'refused' : 'notReady';
};

/** One tone per stance, so the record's chips and this tab's table cannot come out differently. */
export const STANDING_STANCE_TONE: Record<StandingStance, { fg: string; bg: string }> = {
  plannable: { fg: 'var(--success)', bg: 'var(--status-active-bg)' },
  refused: { fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  notReady: { fg: 'var(--warning)', bg: 'var(--status-pending-bg)' },
};

interface Dossier {
  references: any[];
  empanelments: any[];
  backgroundChecks: any[];
  currentCheck: any | null;
  onboarding: any[];
  openIssues: any[];
}

/**
 * The one line at the top of each half of this tab: what it is, and what it wants doing.
 *
 * Both halves used to open on a card headed "Vetting" or "Documents" — nouns, naming a filing
 * cabinet rather than asking for anything — with the state of the file scattered as a hint under
 * one section, a red line under another, and a count nowhere. A clerk had to read the whole tab
 * to find out whether there was anything to do on it.
 *
 * Only the FIRST outstanding thing is named. The list is ordered the way the question is actually
 * asked (see the file's opening note), so naming the first one names the thing that blocks the
 * rest; naming all of them produces a paragraph, which is the clutter this replaces.
 *
 * `nextStep` comes from `ONBOARDING_NEXT_STEP` in @fapoms/shared and wins outright when present.
 * The planner prints that same sentence when it refuses somebody work — "in background
 * verification — complete it on the HR roster" — and this tab is where that instruction lands, so
 * it must be the same words. It is a lookup, never a second copy.
 *
 * Exported for its own test: it is the only prose on the tab that is assembled rather than
 * written, which is where wording goes wrong silently.
 */
export const vettingLede = (facts: {
  section: 'checks' | 'documents';
  hasCheck: boolean;
  referencesTotal: number;
  referencesUnrung: number;
  documentsTotal: number;
  documentsWithoutScan: number;
  originalsNotInOffice: number;
  lifecycleStatus?: string | null;
}): string => {
  const {
    section, hasCheck, referencesTotal, referencesUnrung,
    documentsTotal, documentsWithoutScan, originalsNotInOffice, lifecycleStatus,
  } = facts;
  const joining = onboardingNextStep(lifecycleStatus);

  if (section === 'checks') {
    const opening = 'Whether this person may be sent to a client’s branch, and to which of them.';
    if (joining) return `${opening} They are ${joining}.`;
    if (!hasCheck) return `${opening} No background check has been recorded — do that before they are planned for work.`;
    if (referencesTotal === 0) return `${opening} Nobody is on file as having vouched for them.`;
    if (referencesUnrung > 0) return `${opening} ${counted(referencesUnrung, 'reference')} still to ring.`;
    return `${opening} Nothing is outstanding here.`;
  }

  const opening = 'The paperwork a client’s branch asks for before letting this person near a vault.';
  if (documentsTotal === 0) return `${opening} Nothing is on their record to collect yet.`;
  if (documentsWithoutScan > 0) {
    return `${opening} ${counted(documentsWithoutScan, 'document')} still need a scan on file.`;
  }
  if (originalsNotInOffice > 0) {
    return `${opening} Every scan is in; ${counted(originalsNotInOffice, 'signed original is', 'signed originals are')} still not in the office.`;
  }
  return `${opening} Everything is collected.`;
};

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
              <LinkButton
                onClick={() => remove(i)}
                tone="muted"
                label={`Remove this scan of ${documentLabel}`}
                icon={<Trash2 size={11} />}
              />
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
const LocationPicker: React.FC<{ value: string | null; onChange: (v: string) => void; documentLabel: string }> = ({
  value, onChange, documentLabel,
}) => (
  <select
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value)}
    aria-label={`Which office holds the signed ${documentLabel}`}
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

/**
 * The one thing being edited, whichever of the four it is.
 *
 * Four separate `useState`s held these before — `checkDraft`, `refDraft`, `idDraft` and
 * `standing` — with three rendering an inline panel that expanded inside its card and the fourth
 * a dialog. Nothing prevented two being open at once, and each carried its own Cancel and its own
 * hand-styled Save. One nullable union cannot hold two, and it renders through one `Editor`.
 */
type EditorState =
  | { kind: 'check'; verdict: string; riskGrade: string; cibilScore: string; cibilBand: string; checkedOn: string; findings: string }
  | { kind: 'reference'; id?: string; fullName: string; relationship: string; phone: string }
  | { kind: 'identity'; requirement: string; label: string; documentNumber: string; expiryDate: string }
  | { kind: 'standing'; clientId: string; clientName: string; status: string; statusReason: string; adding: boolean };

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
  /**
   * Where this person is in joining, when the caller knows it.
   *
   * Optional because the dossier does not carry it — it is on the assayer record, which is what
   * renders this tab. Given it, the opening line leads with `ONBOARDING_NEXT_STEP`'s sentence,
   * which is the same one the planner shows when it refuses this person work and which names an
   * action on this very tab.
   */
  lifecycleStatus?: string | null;
}> = ({ assayerId, canManage, section, lifecycleStatus }) => {
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
  const [editor, setEditor] = useState<EditorState | null>(null);
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
  const closeEditor = () => setEditor(null);

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

  /**
   * The clients this person cannot be sent to, split by what has to happen about it.
   *
   * One list before, and it was the wrong list: it held the four refusals and missed the two
   * standings that stop planning without refusing anything. A clerk reading "Not to be planned
   * for Second Bank" while First Bank sat in plain black text — on a DOCUMENTS_PENDING row the
   * planner would never offer — had no way to know the screen was not telling them everything.
   */
  const unplannable = useMemo(() => {
    const rows = (data?.empanelments ?? []).filter((e) => !standingAllowsPlanning(e.status));
    const names = (stance: StandingStance) => rows
      .filter((e) => standingStance(e.status) === stance)
      .map((e) => e.client?.name)
      .filter(Boolean)
      .join(', ');
    return { refused: names('refused'), notReady: names('notReady') };
  }, [data]);

  const saveStanding = async (draft: Extract<EditorState, { kind: 'standing' }>) => {
    if (!draft.clientId) {
      setErr('Choose the client this standing is about.');
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/empanelment/${draft.clientId}`, {
        method: 'PUT',
        body: JSON.stringify({ status: draft.status, statusReason: draft.statusReason || undefined }),
      });
      toast({
        type: 'success',
        title: 'Standing recorded',
        message: `${draft.clientName || 'This client'} — ${STANDING_LABELS[draft.status] ?? draft.status}.`,
      });
      closeEditor();
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveCheck = async (draft: Extract<EditorState, { kind: 'check' }>) => {
    setBusy(true);
    try {
      const score = Number(draft.cibilScore.replace(/[^\d]/g, ''));
      await api.request(`/assayers/${assayerId}/background-check`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: draft.verdict,
          riskGrade: draft.riskGrade || undefined,
          cibilBand: draft.cibilBand || undefined,
          cibilScore: Number.isFinite(score) && score > 0 ? score : undefined,
          checkedOn: draft.checkedOn || undefined,
          findings: draft.findings || undefined,
        }),
      });
      toast({ type: 'success', title: 'Check recorded', message: 'It is now the operative one; the previous check is kept below it.' });
      closeEditor();
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveReference = async (draft: Extract<EditorState, { kind: 'reference' }>) => {
    if (!draft.fullName.trim()) {
      setErr('A reference needs a name.');
      return;
    }
    const editingExisting = !!draft.id;
    setBusy(true);
    setErr(null);
    try {
      await api.request(
        editingExisting
          ? `/assayers/${assayerId}/reference/${draft.id}`
          : `/assayers/${assayerId}/reference`,
        {
          method: editingExisting ? 'PUT' : 'POST',
          body: JSON.stringify({
            fullName: draft.fullName.trim(),
            // `null`, not `undefined`: the server keeps the stored value when a key is absent
            // (`dto.phone ?? row.phone`), so an emptied box would silently put the old number
            // back — which is exactly the correction somebody opens this form to make.
            relationship: draft.relationship || null,
            phone: draft.phone.trim() || null,
          }),
        },
      );
      toast({
        type: 'success',
        title: editingExisting ? 'Reference updated' : 'Reference added',
        message: editingExisting
          ? `${draft.fullName.trim()} corrected.`
          : `${draft.fullName.trim()} is on file. Nobody has rung them yet.`,
      });
      closeEditor();
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveIdentity = async (draft: Extract<EditorState, { kind: 'identity' }>) => {
    /**
     * A document number that is still the mask is not an edit.
     *
     * The dossier masks `documentNumber` the same way the record masks the PAN and Aadhaar it
     * writes through to (`NUMBER_LIVES_ON_THE_PERSON` in the backend), so anything filled from
     * the row rather than typed from the card is `******234F`. The box is opened empty for that
     * reason; this catches the case where somebody pastes a mask back in, which the server would
     * refuse in language about revealing a field they never saw a reveal control for.
     */
    if (looksLikeMask(draft.documentNumber)) {
      setErr(`That is the covered form of the ${draft.label.toLowerCase()} number, not the number. `
        + 'Type it from the document itself, or press Cancel to leave the stored one alone.');
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${draft.requirement}`, {
        method: 'PUT',
        body: JSON.stringify({
          documentNumber: draft.documentNumber.trim(),
          expiryDate: draft.expiryDate || null,
        }),
      });
      closeEditor();
      reload();
    } catch (e) { setErr(userMessage(e)); } finally { setBusy(false); }
  };

  /** One entry point, because there is one Save button. Which endpoint it is stays per kind. */
  const saveEditor = () => {
    if (!editor) return;
    switch (editor.kind) {
      case 'check': void saveCheck(editor); break;
      case 'reference': void saveReference(editor); break;
      case 'identity': void saveIdentity(editor); break;
      case 'standing': void saveStanding(editor); break;
    }
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

  const verify = async (doc: any, verdict: string) => {
    const ok = await confirm({
      title: `Confirm ${doc.label} against the original?`,
      message: `This records that you checked ${doc.documentNumber} against the document itself. `
        + 'A client’s branch relies on it to admit this person to a vault.',
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
  const referencesUnrung = data.references.filter((r) => !r.checkedAt).length;

  const lede = vettingLede({
    section,
    hasCheck: !!check,
    referencesTotal: data.references.length,
    referencesUnrung,
    documentsTotal: paperwork.total,
    documentsWithoutScan: paperwork.total - paperwork.withScan,
    originalsNotInOffice: paperwork.total - paperwork.inHand,
    lifecycleStatus,
  });

  return (
    <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
      {confirmDialog}
      {errorBanner}

      <Lede>{lede}</Lede>

      {editor?.kind === 'standing' && (
        <Editor
          title={editor.adding ? 'Add a client standing' : `Standing with ${editor.clientName}`}
          intro={`This decides whether ${editor.adding ? 'that client' : editor.clientName} will accept this person on their branches. It says nothing about any other client.`}
          onCancel={closeEditor}
          onSave={saveEditor}
          saveLabel="Save standing"
          busy={busy}
        >
          {/*
            One control where there were up to two hundred buttons.

            "No standing recorded for:" was followed by a chip per client — fine against the
            three clients in a demo, and a wall of buttons wrapping across the card on a tenant
            with a real client list, all of them opening the same dialog with one field
            pre-filled. Adding a standing and changing one are now the same act on the same
            surface; the client is simply the first thing you pick.
          */}
          {editor.adding && (
            <Field title="Client" wide>
              <Select
                value={editor.clientId}
                onChange={(v) => setEditor({
                  ...editor,
                  clientId: String(v),
                  clientName: unstanded.find((c) => c.id === String(v))?.name ?? '',
                })}
                options={[
                  { value: '', label: 'Choose a client…' },
                  ...unstanded.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </Field>
          )}
          <Field title="Standing" wide>
            <Select
              value={editor.status}
              onChange={(v) => setEditor({ ...editor, status: String(v) })}
              options={Object.values(EmpanelmentStatus).map((v) => ({
                value: v, label: STANDING_LABELS[v] ?? v,
              }))}
            />
          </Field>
          <Field title="Why (optional)" wide>
            <textarea
              value={editor.statusReason}
              onChange={(e) => setEditor({ ...editor, statusReason: e.target.value })}
              rows={3}
              placeholder={standingAllowsPlanning(editor.status)
                ? 'Anything worth recording alongside this decision.'
                : 'What was the reason? This is the record of why they are not being sent.'}
              style={{ ...fieldInput, resize: 'vertical' }}
            />
          </Field>
        </Editor>
      )}

      {editor?.kind === 'check' && (
        <Editor
          title="Record a background check"
          intro="This becomes the operative check. The one it replaces is kept below it — a picture that changed is the reason to look at a second one."
          onCancel={closeEditor}
          onSave={saveEditor}
          saveLabel="Record check"
          busy={busy}
          width={560}
        >
          <Field title="Verdict">
            <Select
              value={editor.verdict}
              onChange={(v) => setEditor({ ...editor, verdict: String(v) })}
              options={Object.values(BackgroundCheckVerdict).map((v) => ({ value: v, label: VERDICT_LABELS[v] ?? v }))}
            />
          </Field>
          <Field title="Risk">
            <Select
              value={editor.riskGrade}
              onChange={(v) => setEditor({ ...editor, riskGrade: String(v) })}
              options={[{ value: '', label: 'Not graded' }, ...Object.values(RiskGrade).map((v) => ({ value: v, label: RISK_LABELS[v] ?? v }))]}
            />
          </Field>
          <Field title="Credit band">
            <Select
              value={editor.cibilBand}
              onChange={(v) => setEditor({ ...editor, cibilBand: String(v) })}
              options={[{ value: '', label: 'Not recorded' }, ...Object.values(CibilBand).map((v) => ({ value: v, label: CIBIL_LABELS[v] ?? v }))]}
            />
          </Field>
          <Field title="Credit score">
            <input style={fieldInput} inputMode="numeric" placeholder="e.g. 747"
              value={editor.cibilScore}
              onChange={(e) => setEditor({ ...editor, cibilScore: e.target.value })} />
          </Field>
          <Field title="Checked on">
            <input style={fieldInput} type="date"
              value={editor.checkedOn}
              onChange={(e) => setEditor({ ...editor, checkedOn: e.target.value })} />
          </Field>
          <Field title="Findings" wide>
            <input style={fieldInput}
              placeholder="What the check actually turned up. Leave empty if it turned up nothing."
              value={editor.findings}
              onChange={(e) => setEditor({ ...editor, findings: e.target.value })} />
          </Field>
        </Editor>
      )}

      {editor?.kind === 'reference' && (
        <Editor
          title={editor.id ? `Correct ${editor.fullName || 'this reference'}` : 'Add a reference'}
          onCancel={closeEditor}
          onSave={saveEditor}
          saveLabel={editor.id ? 'Save changes' : 'Add reference'}
          busy={busy}
        >
          <Field title="Name" wide>
            <input style={fieldInput} autoFocus value={editor.fullName}
              onChange={(e) => setEditor({ ...editor, fullName: e.target.value })} />
          </Field>
          <Field title="Relationship">
            <Select
              value={editor.relationship}
              onChange={(v) => setEditor({ ...editor, relationship: String(v) })}
              options={[{ value: '', label: 'Not recorded' }, ...RELATIONSHIPS.map((r) => ({ value: r, label: r }))]}
            />
          </Field>
          <Field title="Phone">
            <input style={fieldInput} inputMode="tel" value={editor.phone}
              onChange={(e) => setEditor({ ...editor, phone: e.target.value })} />
          </Field>
        </Editor>
      )}

      {editor?.kind === 'identity' && (
        <Editor
          title={`${editor.label} number`}
          note="Saving replaces the stored number and clears any verification, because somebody checked the old number against the original."
          onCancel={closeEditor}
          onSave={saveEditor}
          saveLabel="Save"
          busy={busy}
        >
          <Field
            title={`${editor.label} number`}
            hint="Type it from the document itself — the stored one is covered on screen, so this box starts empty."
            wide
          >
            <input style={fieldInput} autoFocus value={editor.documentNumber}
              onChange={(e) => setEditor({ ...editor, documentNumber: e.target.value })} />
          </Field>
          <Field title="Expires">
            <input style={fieldInput} type="date" value={editor.expiryDate}
              onChange={(e) => setEditor({ ...editor, expiryDate: e.target.value })} />
          </Field>
        </Editor>
      )}

      {data.openIssues.length > 0 && (
        <Notice
          tone="warning"
          style={{ marginBottom: '14px' }}
          title={`${counted(data.openIssues.length, 'cell')} from the roster import could not be read for this person.`}
        >
          <div style={{ marginTop: '6px' }}>
            {data.openIssues.map((i) => (
              <div key={i.id} style={{ marginBottom: '3px' }}>
                <code style={{ fontSize: '12px' }}>{i.sourceColumn}</code>{' — '}
                {i.reason} Original text: “{i.rawValue}”.
              </div>
            ))}
          </div>
        </Notice>
      )}

      {section === 'checks' && (
        <>
      <Section
        title="Vetting"
        icon={check && verdictTone(check.verdict) === 'var(--danger)' ? ShieldAlert : ShieldCheck}
        style={{ marginBottom: '14px' }}
        action={canManage ? (
          <LinkButton
            icon={<Plus size={11} />}
            onClick={() => setEditor({
              kind: 'check',
              verdict: BackgroundCheckVerdict.CLEAR, riskGrade: '', cibilScore: '',
              cibilBand: '', checkedOn: '', findings: '',
            })}
          >
            Record a check
          </LinkButton>
        ) : undefined}
      >
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
          recording a newer check, which is what the Record-a-check dialog says on opening.
          Without this sentence the absence reads as a missing feature, and somebody eventually
          builds it.
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
        count={data.empanelments.length}
        hint="Whether each bank accepts this person. One answer per client — being active for one says nothing about another."
        style={{ marginBottom: '14px' }}
        action={canManage && unstanded.length > 0 ? (
          <LinkButton
            icon={<Plus size={11} />}
            onClick={() => setEditor({
              kind: 'standing', adding: true,
              clientId: '', clientName: '',
              status: EmpanelmentStatus.RECOMMENDED, statusReason: '',
            })}
          >
            Add a client standing
          </LinkButton>
        ) : undefined}
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
                  <span style={{ fontWeight: 600, color: STANDING_STANCE_TONE[standingStance(e.status)].fg }}>
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
                  <RowActions>
                    <LinkButton onClick={() => setEditor({
                      kind: 'standing', adding: false,
                      clientId: e.clientId, clientName: e.client?.name ?? 'this client',
                      status: e.status, statusReason: e.statusReason ?? '',
                    })}>
                      Change
                    </LinkButton>
                  </RowActions>
                ),
              }] : []),
            ]}
          />
        )}
        {/*
          Both reasons a person is passed over, said separately because they ask for different
          things. "Documents pending" used to sit in this table in plain black with no line under
          it at all, which read as no obstacle whatsoever.
        */}
        {unplannable.refused && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: STANDING_STANCE_TONE.refused.fg }}>
            Not to be planned for {unplannable.refused} — that decision has been taken.
          </div>
        )}
        {unplannable.notReady && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: STANDING_STANCE_TONE.notReady.fg }}>
            Not plannable for {unplannable.notReady} yet either. Nobody has refused them; planning
            offers work only where the standing is Active or Recommended, so they are passed over
            until this one is.
          </div>
        )}
      </Section>

      <Section
        title="References"
        icon={Phone}
        count={data.references.length}
        hint="Who vouched for them, and whether anybody actually rang."
        action={canManage ? (
          <LinkButton
            icon={<Plus size={11} />}
            onClick={() => setEditor({ kind: 'reference', fullName: '', relationship: '', phone: '' })}
          >
            Add reference
          </LinkButton>
        ) : undefined}
      >
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
                  <RowActions>
                    {r.checkedAt
                      ? <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Called</span>
                      : <LinkButton onClick={() => markChecked(r)}>Record call</LinkButton>}
                    <LinkButton
                      onClick={() => setEditor({
                        kind: 'reference',
                        id: r.id,
                        fullName: r.fullName ?? '',
                        relationship: r.relationship ?? '',
                        phone: r.phone ?? '',
                      })}
                    >
                      Change
                    </LinkButton>
                    <LinkButton tone="danger" onClick={() => removeReference(r)}>Remove</LinkButton>
                  </RowActions>
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
                <RowActions>
                  <LinkButton onClick={() => setEditor({
                    kind: 'identity',
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
                  </LinkButton>
                  {d.id && d.documentNumber && d.verificationStatus !== 'VERIFIED' && (
                    <LinkButton onClick={() => verify(d, 'VERIFIED')}>Verify</LinkButton>
                  )}
                  <UploadButton requirement={d.requirement} onPick={attach} documentLabel={d.label} />
                </RowActions>
              ),
            }] : []),
          ]}
        />

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
                ? <LocationPicker value={d.hardCopyLocation} onChange={(v) => setWhere(d.requirement, v)} documentLabel={d.label} />
                : <>{d.hardCopyLocation || '—'}</>),
            },
            ...(canManage ? [{
              key: 'act',
              header: '',
              render: (d: typeof paperwork.joining[number]) => (
                <RowActions>
                  <UploadButton requirement={d.requirement} onPick={attach} documentLabel={d.label} />
                  {/*
                    "Original in" / "Original out" is filing-room shorthand for a toggle: it does
                    not say what pressing it records, and the two read as a pair of opposite
                    actions rather than as one switch. What it actually tracks is whether the
                    signed paper is in the office.
                  */}
                  <LinkButton
                    onClick={() => togglePaperwork(d.requirement, 'hardCopyReceived', d.hardCopyReceived !== true)}
                    label={d.hardCopyReceived === true
                      ? `Record that the signed ${d.label} has left the office`
                      : `Record that the signed ${d.label} is now in the office`}
                  >
                    {d.hardCopyReceived === true ? 'Signed paper has gone out' : 'Signed paper is here'}
                  </LinkButton>
                </RowActions>
              ),
            }] : []),
          ]}
        />
      </Section>
      )}
    </div>
  );
};
