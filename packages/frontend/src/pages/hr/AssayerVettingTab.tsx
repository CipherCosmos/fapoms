import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, Building2, Phone, FileCheck, Plus, Check, Trash2, Lock, Eye } from 'lucide-react';
import {
  EmpanelmentStatus, BackgroundCheckVerdict, RiskGrade, CibilBand, HARD_COPY_LOCATIONS,
  AssayerLifecycleStatus,
  onboardingNextStep, standingAllowsPlanning, scanMimeType, isDrawableScan, identityDocumentFacts,
  isValidPan, isValidAadhaar, storedScanFileName, referenceEmailProblem, referencePhoneForDisplay,
  EMPANELMENT_STANDING_LABELS,
  BACKGROUND_CHECK_VERDICT_LABELS, CheckType, CHECK_TYPE_LABELS, CHECK_REPORT_DOCUMENT, CHECK_ISSUER_LABEL,
  RECHECK_STATUS_LABELS, CheckReviewDecision, ONBOARDING_DOCUMENT_LABELS as REPORT_LABELS,
  isAdverseVerdict, checkTypeForReport, type RecheckStanding, type ComplianceHold,
  hasPassedFinalApproval, OnboardingDocument,
} from '@fapoms/shared';

import { ScanOrAttach } from '../../components/scanner/ScanOrAttach';
import { canApproveJoiners, useCurrentRoles, useCurrentPermissions, useCurrentUserId } from '../../hooks/useCurrentRoles';
import { api } from '../../services/api';
import { Select, useConfirm, useToast, AlertBanner, SkeletonList, DataTable, StatusBadge } from '../../components/ui';
import { RejectDocumentModal } from './RejectDocumentModal';
import {
  label, Empty, Section, Notice, Lede, LinkButton, RowActions, Field, fieldInput, Editor,
} from './hr-ui';
import { looksLikeMask } from './assayer-shared';
import { fmtDate } from '../../utils/dates';
import { userMessage, translateError } from '../../services/errors';
import { DocumentPreviewModal, type DocumentPreviewItem } from '../../components/DocumentPreviewModal';
import { LoadFailure, caughtLoad } from '../../components/LoadFailure';
import { counted } from '../../utils/plural';
import { relationshipOptions } from './reference-vocabulary';
import { EMPANELMENT_STATUS_REASONS, OTHER_STATUS_REASON } from './empanelment-reason-vocabulary';
import { queryClient } from '../../queryClient';
import { invalidateKycMutation } from '../../services/queryInvalidation';

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

// Exported so the record's own move-confirm (AssayerRecord.tsx) can name a verdict in the exact
// words this tab already uses, instead of growing a second, smaller copy of the same five lines.
// The wording itself lives in shared now, where the server's messages read it too.
export const VERDICT_LABELS: Record<string, string> = BACKGROUND_CHECK_VERDICT_LABELS;

/**
 * The plain word HR actually asks for, on top of the same five verdict values.
 *
 * The verdict keeps its five distinctions — CLEAR versus which kind of adverse finding — because
 * that detail is what a decision-maker reads next, and the lifecycle move-confirm above
 * (`ADVERSE_BACKGROUND_VERDICTS`) already acts on two of them specifically. But the question a
 * clerk is holding when they open this tab is simpler: did this person pass their background
 * check, so they can be moved on to Training? `CLEAR` is the only value that answers yes.
 * `NOT_CHECKED` is not a failure — nobody has looked yet — so it gets its own word rather than
 * being folded into "Failed" and read as a verdict that was actually reached and refused.
 *
 * This is presentation only. Nothing here changes what is stored or what the lifecycle-move
 * warning reads off `currentCheck.verdict` — see `move()` in AssayerRecord.tsx.
 */
export type PassFail = 'Passed' | 'Failed' | 'Pending';
export const verdictPassFail = (v?: string | null): PassFail | null => {
  if (!v) return null;
  if (v === BackgroundCheckVerdict.CLEAR) return 'Passed';
  if (v === BackgroundCheckVerdict.NOT_CHECKED) return 'Pending';
  return 'Failed';
};

/** One tone per pass/fail word, in the same two-colours-plus-amber the verdict badge already uses. */
export const PASS_FAIL_TONE: Record<PassFail, { fg: string; bg: string }> = {
  Passed: { fg: 'var(--success)', bg: 'var(--status-active-bg)' },
  Failed: { fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  Pending: { fg: 'var(--warning)', bg: 'var(--status-pending-bg)' },
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

/**
 * One result, in one set of words, wherever it appears — the chip, the history table and the
 * choices in "Record a background check".
 *
 * There used to be two chips side by side for the one fact ("Civil case" and "Failed"), and the
 * dropdown said it a third way ("Civil case (Failed)"). The clerk's word leads; the kind of
 * finding follows only where there is one to name, because "Passed — clear" says nothing twice.
 */
const verdictResultLabel = (v: string): string => {
  const pf = verdictPassFail(v);
  if (pf === 'Passed') return 'Passed';
  if (pf === 'Pending') return 'Pending — not checked yet';
  const detail = (VERDICT_LABELS[v] ?? humanizeEnum(v)).toLowerCase();
  return `Failed — ${detail}`;
};

const VerdictChip: React.FC<{ verdict: string; size?: 'md' }> = ({ verdict, size }) => {
  const tone = PASS_FAIL_TONE[verdictPassFail(verdict) ?? 'Pending'];
  return <StatusBadge size={size} color={tone.fg} bg={tone.bg} label={verdictResultLabel(verdict)} />;
};

/**
 * Verdicts serious enough that carrying somebody forward anyway is a decision, not a formality —
 * exported for the record's own move-confirm (AssayerRecord.tsx), which stops and names the
 * finding before letting a background-verification move go through on top of one of these.
 */
export const ADVERSE_BACKGROUND_VERDICTS: readonly string[] = [
  BackgroundCheckVerdict.CRIMINAL_CASE,
  BackgroundCheckVerdict.ADVERSE_FINDING,
];

/**
 * The plain-English stand-in for a raw enum value that reached the screen with no label mapped to
 * it — a value added to the database before this screen (or a caller reusing its vocabulary) was
 * taught the word for it. "ADVERSE_FINDING" shouted at an HR clerk reads like the software is
 * broken; "Adverse finding" reads like an answer. This is the fallback, never the first choice —
 * every label map above stays the source of truth, and this only runs when a lookup misses.
 */
export const humanizeEnum = (v: string): string =>
  v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const RISK_LABELS: Record<string, string> = {
  [RiskGrade.LOW]: 'Low risk', [RiskGrade.MEDIUM]: 'Medium risk',
  [RiskGrade.HIGH]: 'High risk', [RiskGrade.VERY_HIGH]: 'Very high risk',
};

const CIBIL_LABELS: Record<string, string> = {
  [CibilBand.GOOD]: 'Good', [CibilBand.AVERAGE]: 'Average', [CibilBand.POOR]: 'Poor',
  [CibilBand.BAD]: 'Bad', [CibilBand.NO_CREDIT_HISTORY]: 'No credit history',
  [CibilBand.NOT_CHECKED]: 'Not checked', [CibilBand.CHECK_FAILED]: 'Check failed',
};

/**
 * The words for an empanelment standing, from `@fapoms/shared` — re-exported under the name the
 * three screens here already import, so this file stays their door while the vocabulary itself
 * lives beside the enum.
 *
 * It used to be written out here, and `roster-filters.ts` wrote the same eight words again as
 * `EMPANELMENT_STANDING_LABELS` because this module cannot be imported from a plain logic file
 * (it pulls in `services/socket.ts`, whose `import.meta.env` the logic specs' Jest config
 * cannot parse). Moving the words to shared removes the reason for the second copy.
 */
export const STANDING_LABELS: Record<string, string> = EMPANELMENT_STANDING_LABELS;

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

/**
 * Invariant 1: Empanelment hard-blocks that are NEVER overridable in the UI by any role.
 *
 * Mirrors `STRICTLY_NON_OVERRIDABLE_STANDINGS` in
 * packages/backend/src/modules/assignment/assignment-target-eligibility.policy.ts — EXPIRED and
 * SUSPENDED are kept because that list has them, even though EmpanelmentStatus does not today.
 * On screen this is called "Final", never "hard-blocked" and never by these enum names.
 */
export const HARD_BLOCKED_STANDINGS = new Set<string>([
  'REJECTED',
  'TERMINATED',
  'EXPIRED',
  'SUSPENDED',
]);

/** What a clerk is told when they try to change one of those. The chip beside the row says the same. */
const FINAL_STANDING_MESSAGE = "This bank's decision is final and can't be changed here.";

/**
 * The four refusals that mean "somebody else got to this document first".
 *
 * Read off the error's code, not its words. `userMessage()` replaces the server's text with a
 * plain sentence for exactly these codes, so a check for the code *inside the message* could
 * never match a real response — the refresh below only ever ran in tests that threw a bare
 * `Error`. `technical` still carries the server's own text, for an error that arrived without a
 * code at all.
 */
const REVIEW_CONFLICT_CODES = [
  'DOCUMENT_VERSION_STALE',
  'CANNOT_VERIFY_SUPERSEDED_VERSION',
  'CONTENT_HASH_MISMATCH',
  'DOCUMENT_ALREADY_REVIEWED',
] as const;

const isReviewConflict = (e: unknown): boolean => {
  const { domainCode, technical } = translateError(e);
  return REVIEW_CONFLICT_CODES.some((code) => domainCode === code || (technical ?? '').includes(code));
};

const REVIEW_CONFLICT_MESSAGE = 'Someone else changed this document while you had it open, so your review was not saved. '
  + 'It has been refreshed — please check it again.';

/**
 * Which stored version of a document the reviewer is looking at, and what its bytes hashed to.
 *
 * The dossier puts the hash on each entry of `versions`, not on the document row, so reading
 * `doc.contentSha256` alone sent `expectedContentHash: null` on every real review and the
 * server's "this file changed under you" check never had anything to compare against.
 */
const reviewTarget = (doc: any) => {
  const targetVersionId = doc.currentVersionId ?? doc.id;
  const current = (doc.versions ?? []).find((v: any) => v.id === targetVersionId);
  return {
    targetVersionId,
    expectedDocVersion: doc.docVersion ?? doc.version,
    expectedContentHash: doc.contentSha256 ?? current?.contentSha256 ?? null,
  };
};

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
  /** Report files uploaded and not yet recorded against a check — the report for the next one. */
  bgvReportPending?: ReportFile[];
  /** The same, for every check type that has a report, keyed by the report document. */
  reportPending?: Record<string, ReportFile[]>;
  /** Where they stand on every re-check over time, and anything holding them from new work. */
  compliance?: {
    rechecked: boolean;
    standings: RecheckStanding[];
    hold: ComplianceHold | null;
    blockers: string[];
  } | null;
}

/** One file of a background check's report, as the dossier gives it. */
export interface ReportFile {
  documentId: string;
  versionId: string | null;
  path: string;
  uploadedAt: string | null;
  /** Its position on the report document — present only while it waits for a result. */
  index?: number;
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
  if (status === 'VERIFIED') return <StatusBadge color="var(--success)" bg="var(--status-active-bg)" label="Verified" />;
  if (status === 'REJECTED') return <StatusBadge color="var(--danger)" bg="var(--status-cancelled-bg)" label="Rejected" />;
  return <StatusBadge color="var(--text-muted)" bg="var(--bg-surface-2)" label="Not checked" />;
};

/*
  The types a scan can be — read off the stored key's extension by `scanMimeType`, because
  everything is served as `application/octet-stream` with `nosniff` and a blob left at that is
  something the browser downloads rather than something the viewer can show.
  That table used to live here, and in four other shapes elsewhere: a regular expression for
  thumbnails, a third version inside the viewer whose fallback never ran, and two screens that
  simply trusted the empty type and offered a download. One rule now, in @fapoms/shared beside the
  list of types an upload is allowed to be.
*/

/**
 * The attached scans for one document, opened in the app's one document viewer.
 *
 * This used to fetch every scan the moment the row rendered and show it as a 34px thumbnail or a
 * bare link into a new tab — too small to read a card number off, and for a PDF usually a
 * download. It now opens `DocumentPreviewModal`, the same viewer (zoom, rotate, page through
 * several scans) the verification drawer uses, and fetches only when somebody asks to look.
 *
 * The route needs an Authorization header, so the bytes come through `api.request` as a blob and
 * become an object URL. They are revoked when the viewer closes, or when the row goes away, or
 * the tab keeps a copy of every identity document somebody opened.
 */
export const Attachments: React.FC<{
  documentId: string | null;
  filePaths: string[];
  canManage: boolean;
  onRemoved: () => void;
  /** Failures go to the tab's one banner, not to a toast of this component's own. */
  onError: (message: string) => void;
  /** Which document these scans belong to, so the viewer and the remove button can name it. */
  documentLabel: string;
  /**
   * Where each file is fetched from, when not the document's current file list — a background
   * check's report is served by the upload it was, so it stays viewable whatever happens after.
   */
  urlFor?: (index: number) => string;
  /** The file's position on the document when `filePaths` is a subset of it — what Remove sends. */
  indexFor?: (index: number) => number;
  /** What one file is called on the buttons. */
  noun?: string;
}> = ({ documentId, filePaths, canManage, onRemoved, onError, documentLabel, urlFor, indexFor, noun = 'scan' }) => {
  const [preview, setPreview] = useState<{ items: DocumentPreviewItem[]; index: number } | null>(null);
  const [opening, setOpening] = useState(false);

  const shown = useRef<DocumentPreviewItem[]>([]);
  useEffect(() => () => { shown.current.forEach((item) => URL.revokeObjectURL(item.url)); }, []);

  const open = async (index: number) => {
    if (!documentId || opening) return;
    setOpening(true);
    const made: string[] = [];
    try {
      const items = await Promise.all(filePaths.map(async (key, i) => {
        const bytes = await api.request<Blob>(urlFor ? urlFor(i) : `/assayers/document/${documentId}/file/${indexFor ? indexFor(i) : i}`, { raw: true });
        const type = scanMimeType(key) ?? undefined;
        const url = URL.createObjectURL(type ? new Blob([bytes], { type }) : bytes);
        made.push(url);
        return {
          title: documentLabel, url, mimeType: type,
          fileName: storedScanFileName(documentLabel, key, filePaths.length > 1 ? i + 1 : undefined),
        };
      }));
      shown.current = items;
      setPreview({ items, index });
    } catch (e) {
      made.forEach((u) => URL.revokeObjectURL(u));
      onError(`The scan of ${documentLabel} could not be opened. ${userMessage(e)}`);
    } finally { setOpening(false); }
  };

  const close = () => {
    shown.current.forEach((item) => URL.revokeObjectURL(item.url));
    shown.current = [];
    setPreview(null);
  };

  const remove = async (index: number) => {
    if (!documentId) return;
    try {
      await api.request(`/assayers/document/${documentId}/file/${indexFor ? indexFor(index) : index}`, { method: 'DELETE' });
      onRemoved();
    } catch (e) { onError(userMessage(e)); }
  };

  if (filePaths.length === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;

  const several = filePaths.length > 1;
  return (
    <div style={{ display: 'flex', gap: '6px 12px', alignItems: 'center', flexWrap: 'wrap' }}>
      {filePaths.map((key, i) => (
        <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <LinkButton
            onClick={() => { void open(i); }}
            disabled={opening}
            icon={<Eye size={12} />}
            label={several ? `View ${noun} ${i + 1} of ${documentLabel}` : `View ${noun} of ${documentLabel}`}
          >
            {opening ? 'Opening…' : several ? `View ${noun} ${i + 1}` : `View ${noun}`}
          </LinkButton>
          {canManage && (
            <LinkButton
              onClick={() => { void remove(i); }}
              tone="muted"
              label={several ? `Remove ${noun} ${i + 1} of ${documentLabel}` : `Remove ${noun} of ${documentLabel}`}
              icon={<Trash2 size={11} />}
            >
              Remove
            </LinkButton>
          )}
        </span>
      ))}
      <DocumentPreviewModal
        open={preview !== null}
        onClose={close}
        items={preview?.items ?? []}
        initialIndex={preview?.index ?? 0}
      />
    </div>
  );
};

/**
 * The report one background check was read from — "passed" and "not passed" alike.
 *
 * Served by the upload it was (the version route), not by its place on the document, so a
 * failed check's report stays viewable after a new report arrives for the next check. Never
 * removable: the check cannot be edited or deleted, and neither can its evidence.
 */
export const CheckReport: React.FC<{
  files: ReportFile[];
  /** The report document's current file list — where a file with no recorded upload is found. */
  documentPaths: string[];
  onError: (message: string) => void;
}> = ({ files, documentPaths, onError }) => {
  if (files.length === 0) {
    return <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>No report on file</span>;
  }
  const documentId = files[0].documentId;
  return (
    <Attachments
      documentId={documentId}
      filePaths={files.map((f) => f.path)}
      canManage={false}
      onRemoved={() => undefined}
      onError={onError}
      documentLabel="Background verification report"
      noun="report"
      urlFor={(i) => (files[i].versionId
        ? `/assayers/document/${documentId}/version/${files[i].versionId}/file`
        : `/assayers/document/${documentId}/file/${Math.max(0, documentPaths.indexOf(files[i].path))}`)}
    />
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
  /*
    Two doors, one control (`ScanOrAttach`): the camera with a real scanner behind it for the
    photocopy in the clerk's hand, and the file picker for a flatbed scan or a PDF that arrived by
    email. The accept-list used to be spelled out here and was a narrower copy of the server's —
    TIFF and BMP, which the desk scanners in branches actually write, were refused by this box and
    accepted by every other one. It now comes from the shared list like everywhere else.
  */
  <ScanOrAttach
    documentLabel={documentLabel}
    requirement={requirement}
    size="sm"
    onFiles={(files) => { if (files[0]) onPick(requirement, files[0]); }}
  />
);

/** The office a signed original sits in, chosen rather than typed. */
const LocationPicker: React.FC<{ value: string | null; onChange: (v: string) => void; documentLabel: string }> = ({
  value, onChange, documentLabel,
}) => (
  <select
    value={value ?? ''}
    onChange={(e) => onChange(e.target.value)}
    aria-label={`Which office holds the signed ${documentLabel}`}
    style={{
      padding: '4px 7px', fontSize: 'var(--text-xs)', background: 'var(--bg-surface)',
      color: value ? 'var(--text-primary)' : 'var(--text-muted)',
      border: '1px solid var(--border-color)', borderRadius: '6px', fontFamily: 'inherit',
    }}
  >
    <option value="">Not recorded</option>
    {HARD_COPY_LOCATIONS.map((l) => <option key={l} value={l}>{l}</option>)}
  </select>
);

/**
 * The "why" behind a standing, as a pick from what HR actually writes plus a way to say something
 * else.
 *
 * `status_reason` on this table is mostly the importer's own "Working per roster (Project Name:
 * X)" — nobody typed that, so it is not offered as a choice here. What a person does type
 * clusters into a short list (see `empanelment-reason-vocabulary.ts`); "Other" still takes
 * anything, same as the plain textarea this replaces.
 *
 * A value already on the record that is not one of these clusters — an old free-typed reason, or
 * one of the importer strings this list deliberately excludes — opens straight into the free-text
 * box with that exact text, rather than being blanked because it does not match an option. `other`
 * is seeded once from the incoming value, not recomputed on every render, so picking "Other" for a
 * blank field does not later flip back just because the field is still empty.
 */
const StatusReasonField: React.FC<{ value: string; onChange: (v: string) => void; placeholder: string }> = ({
  value, onChange, placeholder,
}) => {
  const known = !value || (EMPANELMENT_STATUS_REASONS as readonly string[]).includes(value);
  const [other, setOther] = useState(!known);
  return (
    <>
      <Select
        value={other ? OTHER_STATUS_REASON : value}
        onChange={(v) => {
          if (v === OTHER_STATUS_REASON) { setOther(true); } else { setOther(false); onChange(String(v)); }
        }}
        options={[
          { value: '', label: 'Not recorded' },
          ...EMPANELMENT_STATUS_REASONS.map((r) => ({ value: r, label: r })),
          { value: OTHER_STATUS_REASON, label: 'Other (type it in)' },
        ]}
      />
      {other && (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={placeholder}
          style={{ ...fieldInput, resize: 'vertical', marginTop: '6px' }}
        />
      )}
    </>
  );
};

/**
 * The one thing being edited, whichever of the four it is.
 *
 * Four separate `useState`s held these before — `checkDraft`, `refDraft`, `idDraft` and
 * `standing` — with three rendering an inline panel that expanded inside its card and the fourth
 * a dialog. Nothing prevented two being open at once, and each carried its own Cancel and its own
 * hand-styled Save. One nullable union cannot hold two, and it renders through one `Editor`.
 */
type EditorState =
  | { kind: 'check'; checkType: CheckType; verdict: string; riskGrade: string; cibilScore: string; cibilBand: string; checkedOn: string; checkedByName: string; findings: string }
  | { kind: 'reference'; id?: string; fullName: string; relationship: string; phone: string; email: string }
  | { kind: 'identity'; requirement: string; label: string; documentNumber: string; expiryDate: string }
  | { kind: 'standing'; clientId: string; clientName: string; status: string; statusReason: string; adding: boolean };

/**
 * What the card says, typed into the app's own dialog instead of a run of browser prompts.
 *
 * This used to be `window.prompt` once per field — the browser's grey box, outside the app,
 * with no memory of which document was being verified and an Escape key that silently abandoned
 * a half-typed attestation. One form now asks only for the fields the card prints (`prints`
 * comes from the server, as before), pre-filled with whatever is already on file, and Cancel
 * still abandons the whole verification: a half-filled attestation is not one.
 */
const PRINTED_FIELD_LABELS: Record<string, string> = {
  holderName: 'Name exactly as printed',
  holderDateOfBirth: 'Date of birth on the card (YYYY-MM-DD)',
  holderGender: 'Gender on the card',
  holderGuardianName: "Father's or guardian's name on the card",
  holderAddress: 'Address as printed',
};

/**
 * The scan being verified, shown inside the verification dialog.
 *
 * Verifying used to mean opening the scan in one window, closing it, opening this form, and typing
 * from memory what you had just seen. Nobody does that twice: they type the name from the record —
 * which is the one place it is guaranteed to match, and therefore the one place that proves
 * nothing. The card has to be on screen at the moment somebody swears it says what it says.
 */
const ScanBeside: React.FC<{ documentId: string; filePaths: string[] }> = ({ documentId, filePaths }) => {
  const [urls, setUrls] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const made: string[] = [];
    Promise.all(filePaths.map(async (key, i) => {
      const bytes = await api.request<Blob>(`/assayers/document/${documentId}/file/${i}`, { raw: true });
      // The route streams with no usable type; `scanMimeType` reads it off the stored name so the
      // browser draws the scan instead of offering to download it.
      const type = scanMimeType(key) ?? undefined;
      const url = URL.createObjectURL(type ? new Blob([bytes], { type }) : bytes);
      made.push(url);
      return url;
    }))
      .then((list) => { if (live) setUrls(list); else made.forEach((u) => URL.revokeObjectURL(u)); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [documentId, filePaths.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) {
    return (
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>
        The scan could not be opened. Verify from the original document, or ask for it again.
      </div>
    );
  }
  if (urls.length === 0) {
    return <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Opening the scan…</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {urls.map((url, i) => {
        const drawable = isDrawableScan(filePaths[i]);
        return drawable ? (
          <a key={url} href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
            <img
              src={url}
              alt={`Scan ${i + 1}`}
              style={{
                width: '100%', borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)', display: 'block',
              }}
            />
          </a>
        ) : (
          <a key={url} href={url} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 'var(--text-xs)', color: 'var(--primary)' }}
          >
            Open page {i + 1} — this one is a PDF, so it opens in a new tab.
          </a>
        );
      })}
    </div>
  );
};

/**
 * One line for "was this referee told HR may call them?" — what went, and what did not and why.
 *
 * Exported for its spec. The why matters as much as the what: a referee not texted because the
 * text has no registered DLT template needs a different fix from one with no phone at all.
 */
export function referenceNoticeLine(r: { notifiedAt?: string | null; notifiedVia?: string | null; noticeProblem?: string | null }): string {
  const via = (r.notifiedVia ?? '').split(',').filter(Boolean).map((c) => (c === 'SMS' ? 'text' : 'email'));
  const told = r.notifiedAt && via.length > 0 ? `By ${via.join(' and ')}, ${fmtDate(r.notifiedAt)}` : '';
  if (told && r.noticeProblem) return `${told} — ${r.noticeProblem}`;
  if (told) return told;
  if (r.noticeProblem) return `Not told — ${r.noticeProblem}`;
  return 'Not yet';
}

/**
 * The record's address as ONE line, the way an Aadhaar or a utility bill prints it.
 *
 * The record keeps it in parts — street, city, district, state, PIN — and the card prints them
 * run together. Prefilling only the street line left the reviewer to type the other four back in
 * off the card, which is the typing this prefill exists to remove. A part the street line already
 * contains is not repeated ("Pune" twice reads as a mistake to correct).
 */
export function printedAddressFromRecord(person: {
  address?: string | null; city?: string | null; district?: string | null;
  state?: string | null; pincode?: string | null;
} | null | undefined): string | null {
  if (!person) return null;
  const street = (person.address ?? '').trim();
  const lower = street.toLowerCase();
  const parts = [street];
  for (const part of [person.city, person.district, person.state]) {
    const p = (part ?? '').trim();
    if (p && !lower.includes(p.toLowerCase()) && !parts.some((x) => x.toLowerCase() === p.toLowerCase())) parts.push(p);
  }
  const line = parts.filter(Boolean).join(', ');
  const pin = (person.pincode ?? '').trim();
  const withPin = pin && !line.includes(pin) ? (line ? `${line} - ${pin}` : pin) : line;
  return withPin || null;
}

const PrintedDetailsModal: React.FC<{
  label: string;
  prints: { name: boolean; dateOfBirth: boolean; gender: boolean; guardianName: boolean; address: boolean };
  existing: any;
  /**
   * What the record already says, used to pre-fill boxes the document has never had read off
   * it. The reviewer then checks rather than types: anything the card shows differently gets
   * corrected in the box, which is faster and cannot invent a spelling the record never held.
   */
  fallback?: {
    holderName?: string | null;
    holderDateOfBirth?: string | null;
    holderGender?: string | null;
    holderGuardianName?: string | null;
    holderAddress?: string | null;
  } | null;
  /**
   * For a passbook: the record's IFSC, prefilled, and the last digits of the record's account, shown
   * as a hint. The account number itself opens EMPTY and is typed off the page — prefilling it would
   * turn the one check this document exists for into a button that compares the record with itself.
   */
  bank?: { ifscCode?: string | null; accountTail?: string | null } | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}> = ({ label, prints, existing, fallback, bank, onCancel, onSubmit }) => {
  const isPassbook = existing?.requirement === 'BANK_PASSBOOK';
  const [accountRead, setAccountRead] = useState('');
  const [ifscRead, setIfscRead] = useState(() => String(bank?.ifscCode ?? '').toUpperCase());
  const wanted: Array<[string, 'name' | 'dateOfBirth' | 'gender' | 'guardianName' | 'address']> = ([
    ['holderName', 'name'],
    ['holderDateOfBirth', 'dateOfBirth'],
    ['holderGender', 'gender'],
    ['holderGuardianName', 'guardianName'],
    ['holderAddress', 'address'],
  ] as Array<[string, 'name' | 'dateOfBirth' | 'gender' | 'guardianName' | 'address']>).filter(([, flag]) => prints[flag]);
  const read = (key: string): string => {
    const fromDoc = key === 'holderDateOfBirth'
      ? String(existing?.[key] ?? '').slice(0, 10)
      : String(existing?.[key] ?? '');
    if (fromDoc.trim() !== '') return fromDoc;
    const fromRecord = key === 'holderDateOfBirth'
      ? String(fallback?.[key as keyof NonNullable<typeof fallback>] ?? '').slice(0, 10)
      : String(fallback?.[key as keyof NonNullable<typeof fallback>] ?? '');
    return fromRecord;
  };
  const [values, setValues] = useState<Record<string, string>>(() => ({
    holderName: read('holderName'),
    holderDateOfBirth: read('holderDateOfBirth'),
    holderGender: read('holderGender'),
    holderGuardianName: read('holderGuardianName'),
    holderAddress: read('holderAddress'),
  }));
  /**
   * The boxes that opened with the RECORD's answer rather than one read off this card.
   *
   * Named per box, not as one line over the form: the reviewer's job is to compare exactly these
   * against the scan, and a single "some of this was prefilled" left them guessing which. Frozen
   * at open, so the marker stays put while they correct a box — it records where the value came
   * from, not whether they have touched it since.
   */
  const [fromRecord] = useState<Set<string>>(() => new Set(
    wanted
      .filter(([key]) => String(existing?.[key] ?? '').trim() === '' && read(key).trim() !== '')
      .map(([key]) => key),
  ));
  const prefilled = fromRecord.size > 0;
  const submit = () => {
    const out: Record<string, string> = {};
    for (const [key] of wanted) {
      if (String(values[key] ?? '').trim()) out[key] = String(values[key]).trim();
    }
    if (isPassbook) {
      // Compared with the record by the server, digit for digit — not stored on the document.
      out.accountNumber = accountRead.trim();
      out.ifscCode = ifscRead.trim().toUpperCase();
    }
    onSubmit(out);
  };
  const scans: string[] = existing?.filePaths ?? [];
  const hasScan = !!existing?.id && scans.length > 0;

  return (
    <Editor
      title={`What does the ${label} say?`}
      intro={prefilled
        ? (hasScan
          ? 'Prefilled from their record — check each marked box against the scan beside it, and correct anything the card shows differently.'
          : 'Prefilled from their record — check each marked box against the original document in front of you, and correct anything it shows differently.')
        : (hasScan
          ? 'The scan is here beside the boxes. Read each value off it — this is what the record is checked against.'
          : 'No scan has been attached yet, so read from the original document in front of you.')}
      onCancel={onCancel}
      onSave={submit}
      saveLabel="Use these details"
      width={hasScan ? 860 : 480}
    >
      {hasScan && (
        <div style={{ flex: '1 1 320px', minWidth: '280px' }}>
          <ScanBeside documentId={existing.id} filePaths={scans} />
        </div>
      )}
      <div style={{ flex: '1 1 260px', minWidth: '240px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {wanted.map(([key]) => (
        <div key={key}>
          <label htmlFor={`vetting-printed-${key}`} style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
            {PRINTED_FIELD_LABELS[key]}
          </label>
          <input
            id={`vetting-printed-${key}`}
            type={key === 'holderDateOfBirth' ? 'date' : 'text'}
            value={values[key] ?? ''}
            onChange={(e) => setValues({ ...values, [key]: e.target.value })}
            aria-describedby={fromRecord.has(key) ? `vetting-printed-${key}-source` : undefined}
            style={{
              width: '100%', padding: '8px 10px', fontSize: 'var(--text-sm)',
              background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
              border: `1px solid ${fromRecord.has(key) ? 'var(--warning)' : 'var(--border-color)'}`,
              borderRadius: 'var(--radius-sm)',
              outline: 'none', boxSizing: 'border-box',
            }}
          />
          {fromRecord.has(key) && (
            <div
              id={`vetting-printed-${key}-source`}
              style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '3px' }}
            >
              From their record — check it against the card
            </div>
          )}
        </div>
      ))}
      {isPassbook && (
        <>
          <div>
            <label htmlFor="vetting-passbook-account" style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
              Account number, as printed
            </label>
            <input
              id="vetting-passbook-account"
              value={accountRead}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => setAccountRead(e.target.value)}
              // Read off the page, not pasted from the record — that would compare it with itself.
              onPaste={(e) => e.preventDefault()}
              aria-describedby="vetting-passbook-account-hint"
              style={{
                width: '100%', padding: '8px 10px', fontSize: 'var(--text-sm)', fontFamily: 'monospace',
                background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', boxSizing: 'border-box',
              }}
            />
            <div id="vetting-passbook-account-hint" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '3px' }}>
              Type it from the passbook. {bank?.accountTail ? `The record's account ends ${bank.accountTail}.` : ''}
            </div>
          </div>
          <div>
            <label htmlFor="vetting-passbook-ifsc" style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
              IFSC, as printed
            </label>
            <input
              id="vetting-passbook-ifsc"
              value={ifscRead}
              autoComplete="off"
              onChange={(e) => setIfscRead(e.target.value.toUpperCase())}
              aria-describedby={bank?.ifscCode ? 'vetting-passbook-ifsc-source' : undefined}
              style={{
                width: '100%', padding: '8px 10px', fontSize: 'var(--text-sm)', fontFamily: 'monospace', textTransform: 'uppercase',
                background: 'var(--bg-surface-2)', color: 'var(--text-primary)', boxSizing: 'border-box',
                border: `1px solid ${bank?.ifscCode ? 'var(--warning)' : 'var(--border-color)'}`, borderRadius: 'var(--radius-sm)',
              }}
            />
            {bank?.ifscCode && (
              <div id="vetting-passbook-ifsc-source" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '3px' }}>
                From their record — check it against the passbook
              </div>
            )}
          </div>
        </>
      )}
      </div>
    </Editor>
  );
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
  /**
   * Where this person is in joining, when the caller knows it.
   *
   * Optional because the dossier does not carry it — it is on the assayer record, which is what
   * renders this tab. Given it, the opening line leads with `ONBOARDING_NEXT_STEP`'s sentence,
   * which is the same one the planner shows when it refuses this person work and which names an
   * action on this very tab.
   */
  lifecycleStatus?: string | null;
  /**
   * Switches the record over to the Documents half of this same dossier.
   *
   * A clerk holding a PAN or Aadhaar card looks for where to check it on the tab named for
   * background checks, because checking the card *is* part of vetting to them. The first line of
   * the Background half says where that happens and, given this, links there. Optional: a caller
   * that has not wired tab-switching still gets the same sentence as plain text.
   */
  onGoToDocuments?: () => void;
  /**
   * The person's record, when the caller has it — what the verification boxes pre-fill from.
   * The dossier carries the documents but not the person, so without this the reviewer types
   * the name off the card even when the record already holds the same spelling.
   */
  person?: {
    /** With the lifecycle, decides whether the ID-card photo is locked (see `hasPassedFinalApproval`). */
    unavailableReason?: string | null;
    /** A photo can sit only on the person (an old import) with no document row files behind it. */
    photograph?: string | null;
    displayName?: string | null;
    dateOfBirth?: string | null;
    gender?: string | null;
    address?: string | null;
    city?: string | null;
    district?: string | null;
    state?: string | null;
    pincode?: string | null;
    /** The record's IFSC — what a passbook's IFSC is compared with, so it opens prefilled. */
    ifscCode?: string | null;
  } | null;
  /**
   * The same pointer the other way: switches the record over to the Background half.
   *
   * The background check report is a document, but the check it records and each bank's decision
   * are on the other half, and somebody who arrived on Documents to file the report has no reason
   * to guess that. Optional for the same reason as `onGoToDocuments`.
   */
  onGoToChecks?: () => void;
  /**
   * Called after this tab re-reads its dossier following a write. This tab keeps its own copy of
   * the dossier, so a container that shows readiness from the same facts — the onboarding drawer's
   * step checklist — needs to hear about a check recorded or a document verified here.
   */
  onChanged?: () => void;
  /**
   * Takes somebody parked for not passing background verification back into it — the record's
   * own move, with its confirmation. Given only when that move is open to this person.
   */
  onReopenBackgroundVerification?: () => void;
}> = ({ assayerId, canManage, section, lifecycleStatus, person, onGoToDocuments, onGoToChecks, onChanged, onReopenBackgroundVerification }) => {
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
  /** The background verification report document — every report file ever uploaded, all checks'. */
  const bgvReport = (data?.onboarding ?? [])
    .find((d: { requirement: string }) => d.requirement === 'BGV_REPORT') as { id?: string; filePaths?: string[]; issuedBy?: string | null } | undefined;
  /**
   * The report for the NEXT check: files uploaded that no recorded check was read from. A result
   * is recorded against these and nothing else — the reports of earlier checks stay with them.
   */
  const bgvPending = data?.bgvReportPending ?? [];
  /** The agency named when the report was uploaded — what the check's own agency box opens with. */
  const bgvReportIssuer = bgvReport?.issuedBy ?? '';
  /**
   * The same four facts for any check type that has a report of its own (police certificate,
   * credit report) — what the check dialog shows for the type being recorded. Null for the
   * identity re-check, which re-verifies the identity documents themselves.
   */
  const reportFor = (type: CheckType) => {
    const requirement = CHECK_REPORT_DOCUMENT[type];
    if (!requirement) return null;
    const doc = (data?.onboarding ?? []).find((d: { requirement: string }) => d.requirement === requirement) as
      { id?: string; filePaths?: string[]; issuedBy?: string | null } | undefined;
    const pending = (type === CheckType.BGV ? data?.bgvReportPending : undefined) ?? data?.reportPending?.[requirement] ?? [];
    return {
      requirement,
      label: REPORT_LABELS[requirement as keyof typeof REPORT_LABELS] ?? requirement,
      doc,
      pending,
      earlier: (doc?.filePaths?.length ?? 0) - pending.length,
      issuer: doc?.issuedBy ?? '',
    };
  };
  const { confirm, confirmWithReason, confirmDialog } = useConfirm();
  const { toast } = useToast();
  /** The senior's decision on an adverse re-check — ASSAYER:APPROVE, never whoever recorded it. */
  const canApprove = canApproveJoiners(useCurrentRoles(), useCurrentPermissions());
  const currentUserId = useCurrentUserId();
  const [reviewText, setReviewText] = useState('');
  const [reviewErr, setReviewErr] = useState<string | null>(null);
  /** The document a "Send it back" click is choosing a reason for — the dialog is open exactly when this is set. */
  const [rejectTarget, setRejectTarget] = useState<any | null>(null);
  // A document HR already accepted (or the locked ID-card photo), being asked for again.
  const [reuploadTarget, setReuploadTarget] = useState<any | null>(null);
  /** Why the dossier itself is not here — kept apart from `err`, which every write reports to. */
  const [dossierErr, setDossierErr] = useState<unknown>(null);
  /** The document whose card details are being read off — the dialog is open exactly when this is set. */
  const [printedTarget, setPrintedTarget] = useState<any | null>(null);
  /**
   * A failed save that belongs to the dialog currently open.
   *
   * Separate from `err`, which is the page's own banner: the banner renders behind the dialog, so
   * a save failure reported there was invisible to the person who caused it. Cleared whenever an
   * editor opens, so an old failure never greets a new attempt.
   */
  const [editorErr, setEditorErr] = useState<string | null>(null);
  /**
   * A message that has to stay up through the re-read it asks for.
   *
   * The dossier effect below clears `err` as it starts, which is right after an ordinary save and
   * wrong for "someone else changed this document — it has been refreshed": that sentence was
   * wiped in the same instant the refresh it announces began, so the clerk saw nothing at all.
   */
  const keepThroughReload = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(keepThroughReload.current);
    keepThroughReload.current = null;
    setDossierErr(null);
    api.request<Dossier>(`/assayers/${assayerId}/dossier`)
      .then((d) => { if (!cancelled) { setData(d); setDossierErr(null); } })
      // Read failures go to their own channel, not to `err`. `err` is the write channel and is
      // dismissible by design; dismissing it when the dossier never arrived left this tab as an
      // empty div with no explanation and no way back to one.
      .catch((e) => { if (!cancelled) setDossierErr(e); });
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

  const reload = () => { setReloadKey((k) => k + 1); onChanged?.(); };
  const closeEditor = () => { setEditor(null); setEditorErr(null); };

  /** A review that lost the race: say so, and re-read the document so what is on screen is current. */
  const refreshAfterReviewConflict = (documentId: string) => {
    keepThroughReload.current = REVIEW_CONFLICT_MESSAGE;
    setErr(REVIEW_CONFLICT_MESSAGE);
    void invalidateKycMutation(queryClient, assayerId, documentId);
    reload();
  };

  const paperwork = useMemo(() => {
    /*
      A POLICE CERTIFICATE AND A CREDIT REPORT ARE NOT JOINING PAPERWORK.

      They are the reports behind the periodic re-checks (2026-09-23), which begin once somebody is
      working — joining needs the background verification and nothing else of the kind. They were
      listed for every candidate anyway, each with "Upload on the Background tab", which sent the
      desk to look for a police check that hiring has no step for. So they are listed only for
      somebody on re-checks, or when a file is already on one — a report uploaded is never hidden.
    */
    const rechecked = !!data?.compliance?.rechecked;
    const rows = (data?.onboarding ?? []).filter((r) => {
      const check = checkTypeForReport(r.requirement);
      if (!check || check === CheckType.BGV) return true;
      return rechecked || (r.filePaths ?? []).length > 0;
    });
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
      // Everything a reviewer VERIFIES against the original sits together — the identity documents,
      // and the passbook, which is checked against the account the pay goes to.
      identity: rows.filter((r) => r.identity || r.verifiable),
      joining: rows.filter((r) => !(r.identity || r.verifiable)),
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
      setErr('Choose the bank this standing is about.');
      return;
    }
    const existing = (data?.empanelments ?? []).find((e) => e.clientId === draft.clientId);
    if (existing && HARD_BLOCKED_STANDINGS.has(existing.status)) {
      setErr(FINAL_STANDING_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      // `expectedVersion` is the revision this screen loaded. The server refuses a change to an
      // existing standing that arrives without it, and refuses one whose version has moved on —
      // two desks deciding at once used to both be told they had saved. See
      // `empanelment-version.ts`. Absent only for a first standing, which overwrites nothing.
      await api.request(`/assayers/${assayerId}/empanelment/${draft.clientId}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: draft.status,
          statusReason: draft.statusReason || undefined,
          expectedVersion: existing?.version,
        }),
      });
      toast({
        type: 'success',
        title: 'Standing recorded',
        message: `${draft.clientName || 'This client'} — ${STANDING_LABELS[draft.status] ?? draft.status}.`,
      });
      closeEditor();
      reload();
    } catch (e) { setEditorErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveCheck = async (draft: Extract<EditorState, { kind: 'check' }>) => {
    // Said here, in the dialog, rather than after a round trip — the server refuses the same thing.
    const completed = draft.verdict !== BackgroundCheckVerdict.NOT_CHECKED;
    const report = reportFor(draft.checkType);
    if (completed && CHECK_ISSUER_LABEL[draft.checkType] && !draft.checkedByName.trim()) {
      setEditorErr(draft.checkType === CheckType.BGV
        ? 'Name the agency that carried out the background verification.'
        : `Name the ${String(CHECK_ISSUER_LABEL[draft.checkType]).toLowerCase()}.`);
      return;
    }
    if (completed && report && report.pending.length === 0) {
      setEditorErr(report.earlier > 0
        ? 'Upload the report for this check. The report already on file belongs to the check recorded before, and stays with it.'
        : draft.checkType === CheckType.BGV
          ? 'Upload the background verification report first — the result is only as good as the report it came from.'
          : `Upload the ${report.label.toLowerCase()} first — the result is only as good as the report it came from.`);
      return;
    }
    if (completed && draft.checkType === CheckType.IDENTITY && draft.findings.trim().length < 10) {
      setEditorErr('Say which identity documents were re-checked against the originals, and what was found.');
      return;
    }
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
          checkedByName: draft.checkedByName?.trim() || undefined,
          findings: draft.findings || undefined,
          checkType: draft.checkType,
        }),
      });
      toast({
        type: 'success',
        title: 'Check recorded',
        message: isAdverseVerdict(draft.verdict) && data?.compliance?.rechecked
          ? 'Recorded. It came back adverse, so they are held from new work until a senior decides.'
          // The identity re-check has no report of its own — see `CHECK_REPORT_DOCUMENT`.
          : `${CHECK_TYPE_LABELS[draft.checkType]} recorded${CHECK_REPORT_DOCUMENT[draft.checkType] ? ', with its report' : ''}.`,
      });
      closeEditor();
      reload();
    } catch (e) { setEditorErr(userMessage(e)); } finally { setBusy(false); }
  };

  const saveReference = async (draft: Extract<EditorState, { kind: 'reference' }>) => {
    // Into the dialog (`editorErr`), not the page banner: the banner sits BEHIND the open dialog,
    // so a refusal written there is one nobody reads — see `Editor`'s own `error` prop.
    if (!draft.fullName.trim()) {
      setEditorErr('A reference needs a name.');
      return;
    }
    if (draft.email.trim() && referenceEmailProblem(draft.email.trim().toLowerCase())) {
      setEditorErr('That email does not look right.');
      return;
    }
    setEditorErr(null);
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
            email: draft.email.trim().toLowerCase() || null,
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
    } catch (e) { setEditorErr(userMessage(e)); } finally { setBusy(false); }
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
      setEditorErr(`That is the covered form of the ${draft.label.toLowerCase()} number, not the number. `
        + 'Type it from the document itself, or press Cancel to leave the stored one alone.');
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${draft.requirement}`, {
        method: 'PUT',
        body: JSON.stringify({
          documentNumber: draft.documentNumber.trim(),
          // Only sent for a document that has one. A PAN card was being saved with an expiry
          // field it can never carry.
          ...(identityDocumentFacts(draft.requirement).expires ? { expiryDate: draft.expiryDate || null } : {}),
        }),
      });
      closeEditor();
      reload();
    } catch (e) { setEditorErr(userMessage(e)); } finally { setBusy(false); }
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

  /**
   * Recording that somebody checked a document against its original.
   *
   * The reviewer is asked what the card says before the verdict is taken, because that is what the
   * record's own name is then compared against — until the document's name was written down there
   * was nothing to check the record against, and a verification that compares nothing attests to
   * nothing. The server refuses a name that does not agree, and that refusal names both names, so
   * it is put in front of the reviewer rather than replaced with something generic.
   */
  const verify = async (doc: any, printed: Record<string, string>) => {
    const ok = await confirm({
      title: `Confirm ${doc.label} against the original?`,
      message: `This records that you checked ${doc.documentNumber} and the name `
        + `“${printed.holderName ?? '—'}” against the document itself. A client’s branch relies on `
        + 'it to admit this person to a vault.',
      confirmLabel: 'Yes, I checked it',
    });
    if (!ok) return;

    setBusy(true);
    const { targetVersionId, expectedDocVersion, expectedContentHash } = reviewTarget(doc);

    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: 'VERIFIED',
          targetVersionId,
          expectedDocVersion,
          expectedContentHash,
          ...printed,
        }),
      });
      void invalidateKycMutation(queryClient, assayerId, doc.id);
      reload();
    } catch (e) {
      if (isReviewConflict(e)) {
        refreshAfterReviewConflict(doc.id);
        return;
      }
      const message = userMessage(e);
      if (/does not match the name on the record/i.test(message)) {
        // Genuinely the same person under a different name — maiden versus married, initials
        // expanded — is routine, so the reviewer answers in the app's own dialog rather than
        // the browser's. Ten characters minimum, as before: the note is the audit trail.
        const { confirmed, reason } = await confirmWithReason({
          title: 'The name does not match',
          message,
          confirmLabel: 'Verify anyway',
          reasonPrompt: {
            label: 'If it is the same person, say why:',
            placeholder: 'e.g. Maiden name on the card, married name already on the record',
          },
        });
        if (!confirmed) { setErr(message); return; }
        if (reason.length < 10) {
          setErr(`${message} If it is the same person, say why in at least 10 characters.`);
          return;
        }
        try {
          await api.request(`/assayers/document/${doc.id}/verify`, {
            method: 'POST',
            body: JSON.stringify({
              verdict: 'VERIFIED',
              targetVersionId,
              expectedDocVersion,
              expectedContentHash,
              ...printed,
              nameMismatchNote: reason,
            }),
          });
          reload();
          return;
        } catch (retry) {
          if (isReviewConflict(retry)) refreshAfterReviewConflict(doc.id);
          else setErr(userMessage(retry));
          return;
        }
      }
      setErr(message);
    } finally { setBusy(false); }
  };

  /**
   * Sending a scan back — the half of a review this screen could not do.
   *
   * `verify(d, 'VERIFIED')` was hard-coded at both call sites, so a reviewer could only ever agree.
   * A document too dark to read had no outcome at all: it sat as PENDING forever, the person who
   * sent it was told nothing, and the desk had no queue to work.
   */
  const reject = async (doc: any, reason: string, note: string) => {
    setBusy(true);
    const { targetVersionId, expectedDocVersion, expectedContentHash } = reviewTarget(doc);

    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: 'REJECTED',
          rejectionReason: reason,
          targetVersionId,
          expectedDocVersion,
          expectedContentHash,
          ...(note.trim() ? { remarks: note.trim() } : {}),
        }),
      });
      void invalidateKycMutation(queryClient, assayerId, doc.id);
      reload();
    } catch (e) {
      if (isReviewConflict(e)) {
        refreshAfterReviewConflict(doc.id);
        return;
      }
      setErr(userMessage(e));
    } finally { setBusy(false); }
  };

  /**
   * Asking again for something already accepted.
   *
   * A verified document — and, once someone is approved, their ID-card photo — is locked against
   * the assayer: they cannot replace it from the phone. This is the one way to unlock it. The
   * accepted copy stays in the document's history; the reason goes to their phone.
   */
  const requestReupload = async (doc: any, reason: string, note: string) => {
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/document/${doc.requirement}/request-reupload`, {
        method: 'POST',
        body: JSON.stringify({ reason, note }),
      });
      if (doc.id) void invalidateKycMutation(queryClient, assayerId, doc.id);
      reload();
    } catch (e) {
      setErr(userMessage(e));
    } finally { setBusy(false); }
  };

  /** The ID-card photo locks once the person is approved; only then is asking again meaningful. */
  const photoLocked = hasPassedFinalApproval(lifecycleStatus, person?.unavailableReason ?? null);

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

  /** The check dialog — also where the report is uploaded, since it needs the agency named there. */
  const openCheckEditor = (checkType: CheckType = CheckType.BGV) => setEditor({
    kind: 'check',
    checkType,
    verdict: BackgroundCheckVerdict.CLEAR, riskGrade: '', cibilScore: '',
    cibilBand: '', checkedOn: '', checkedByName: reportFor(checkType)?.issuer ?? '', findings: '',
  });

  /**
   * The report, uploaded from the check dialog WITH the agency that produced it — the server will
   * not take one without. Its own handler rather than `attach`, because `attach` reports into the
   * page banner behind the dialog, where a refusal is one nobody reads.
   */
  const attachBgvReport = async (file: File) => {
    const type = editor?.kind === 'check' ? editor.checkType : CheckType.BGV;
    const report = reportFor(type);
    if (!report) return;
    const agency = editor?.kind === 'check' ? editor.checkedByName.trim() : '';
    if (!agency) {
      setEditorErr(type === CheckType.BGV
        ? 'Name the agency that carried out the background verification, then upload its report.'
        : `Name the ${String(CHECK_ISSUER_LABEL[type]).toLowerCase()}, then upload the ${report.label.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    setEditorErr(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('issuedBy', agency);
      await api.request(`/assayers/${assayerId}/document/${report.requirement}/file`, { method: 'POST', body: form });
      reload();
    } catch (e) { setEditorErr(userMessage(e)); } finally { setBusy(false); }
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

  /**
   * Tell (again) a referee that HR may call them. Reports what actually went, including a text the
   * gateway could not carry, so "Tell them" never looks like it worked when it did not.
   */
  const notifyReferee = async (ref: any) => {
    setBusy(true);
    try {
      const out = await api.request<{ channels: string[]; problem: string | null }>(
        `/assayers/${assayerId}/reference/${ref.id}/notify`, { method: 'POST', body: JSON.stringify({}) },
      );
      const how = out.channels.map((c) => (c === 'SMS' ? 'text' : 'email')).join(' and ');
      toast(out.channels.length > 0
        ? { type: 'success', title: `${ref.fullName} told by ${how}`, message: out.problem ? `Not every way went: ${out.problem}.` : 'They know HR may call them.' }
        : { type: 'error', title: `Could not tell ${ref.fullName}`, message: out.problem ?? 'Nothing could be sent.' });
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
        {/* The read's own failure: permanent while it stands, and it says whether this was a
            refusal (this tab carries background checks and identity documents, which not every
            HR role may open) or an outage that Retry could clear. */}
        {dossierErr != null
          ? <LoadFailure loads={[{ label: "this assayer's vetting file", query: caughtLoad(dossierErr, reload) }]} />
          /* Was the word "Loading…" in the middle of an empty card. */
          : !err && <SkeletonList rows={3} height={92} />}
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

  /**
   * No verdicts while INVITED — review opens at document verification.
   *
   * Collecting scans stays open at every stage; only the verdict needs the stage to have
   * started, or the same scans get verified twice (once here, once in the stage flow). The
   * server refuses it too — this keeps the buttons from promising what the API will not do.
   */
  const reviewLocked = lifecycleStatus === AssayerLifecycleStatus.INVITED;
  const reviewLockHint = 'Start document verification first';

  return (
    <div style={{ opacity: busy ? 0.6 : 1, transition: 'opacity .15s' }}>
      {confirmDialog}
      {rejectTarget && (
        <RejectDocumentModal
          label={rejectTarget.label}
          onCancel={() => setRejectTarget(null)}
          onSubmit={(reason, note) => {
            const doc = rejectTarget;
            setRejectTarget(null);
            void reject(doc, reason, note);
          }}
        />
      )}
      {reuploadTarget && (
        <RejectDocumentModal
          mode="reupload"
          label={reuploadTarget.label}
          onCancel={() => setReuploadTarget(null)}
          onSubmit={(reason, note) => {
            const doc = reuploadTarget;
            setReuploadTarget(null);
            void requestReupload(doc, reason, note);
          }}
        />
      )}
      {printedTarget && (
        <PrintedDetailsModal
          label={printedTarget.label}
          prints={printedTarget.prints ?? { name: true, dateOfBirth: false, gender: false, guardianName: false, address: false }}
          existing={printedTarget}
          fallback={person ? {
            holderName: person.displayName ?? null,
            holderDateOfBirth: person.dateOfBirth ?? null,
            holderGender: person.gender ?? null,
            holderAddress: printedAddressFromRecord(person),
          } : null}
          bank={printedTarget.requirement === 'BANK_PASSBOOK' ? {
            ifscCode: person?.ifscCode ?? null,
            // The dossier shows the record's account masked; its last digits are all this needs.
            accountTail: printedTarget.documentNumber ? `…${String(printedTarget.documentNumber).slice(-4)}` : null,
          } : null}
          onCancel={() => setPrintedTarget(null)}
          onSubmit={(printed) => {
            const doc = printedTarget;
            setPrintedTarget(null);
            void verify(doc, printed);
          }}
        />
      )}
      {errorBanner}

      <Lede>{lede}</Lede>

      {/*
        Where the other half is. The two tabs read one dossier, and a clerk's idea of "vetting"
        includes checking the PAN card, so each half says in one line what lives on the other.
      */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '-6px 0 14px', lineHeight: 1.5 }}>
        {section === 'checks' ? (
          <>
            PAN, Aadhaar and other document checks are on the{' '}
            {onGoToDocuments ? <LinkButton onClick={onGoToDocuments}>Documents tab</LinkButton> : 'Documents tab'}.
          </>
        ) : (
          <>
            The background check and bank approvals are on the{' '}
            {onGoToChecks ? <LinkButton onClick={onGoToChecks}>Background tab</LinkButton> : 'Background tab'}.
          </>
        )}
      </div>

      {editor?.kind === 'standing' && (
        <Editor
          error={editorErr}
          title={editor.adding ? 'Add standing with a bank' : `Standing with ${editor.clientName}`}
          intro={`This decides whether ${editor.adding ? 'that bank' : editor.clientName} will accept this person on their branches. It says nothing about any other bank.`}
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
            <Field title="Bank" wide>
              <Select
                value={editor.clientId}
                onChange={(v) => setEditor({
                  ...editor,
                  clientId: String(v),
                  clientName: unstanded.find((c) => c.id === String(v))?.name ?? '',
                })}
                options={[
                  { value: '', label: 'Choose a bank…' },
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
                value: v, label: STANDING_LABELS[v] ?? humanizeEnum(v),
              }))}
            />
          </Field>
          <Field title="Why (optional)" wide>
            <StatusReasonField
              key={editor.clientId}
              value={editor.statusReason}
              onChange={(v) => setEditor({ ...editor, statusReason: v })}
              placeholder={standingAllowsPlanning(editor.status)
                ? 'Anything worth recording alongside this decision.'
                : 'What was the reason? This is the record of why they are not being sent.'}
            />
          </Field>
        </Editor>
      )}

      {editor?.kind === 'check' && (() => {
        const type = editor.checkType;
        const report = reportFor(type);
        const issuerLabel = CHECK_ISSUER_LABEL[type];
        const isBgv = type === CheckType.BGV;
        return (
        <Editor
          error={editorErr}
          title={isBgv ? 'Record the background check' : `Record a ${CHECK_TYPE_LABELS[type].toLowerCase()}`}
          intro={type === CheckType.IDENTITY
            ? 'Record re-checking their identity documents against the originals — and what was found. Each check is kept for good; this one does not replace an earlier one.'
            : `Record what the ${isBgv ? 'agency' : String(issuerLabel ?? 'issuer').toLowerCase()} reported. Passed or not, the report is kept with the result, and earlier checks stay on the record.`}
          onCancel={closeEditor}
          onSave={saveEditor}
          saveLabel="Record check"
          busy={busy}
          width={560}
        >
          {/*
            ONE CHECK PER DIALOG, CHOSEN BY THE BUTTON THAT OPENED IT.

            This dialog used to open with a row of four chips — background, police, credit,
            identity — above one shared set of fields. It read as one form in four parts: the result
            and the date stayed filled in as you moved between chips, each chip offered its own
            upload, and "Record check" then saved only whichever chip happened to be selected. A
            desk passing a candidate through background verification went round all four,
            uploaded three reports, finished on "Identity re-check", and was refused for not
            describing an identity re-check — with nothing recorded at all.

            Every way in already knows which check it is for: "Record a check" and "Record its
            result" on the Background check card are the background verification, and each row of
            "Re-checks over time" is its own check. So there is nothing to choose here, and no way
            to save a check other than the one the dialog was opened for.
          */}
          {/* Who issued it first: the report is not taken without that name. */}
          {issuerLabel && (
            <Field title={issuerLabel}>
              <input style={fieldInput}
                aria-label={issuerLabel}
                placeholder={isBgv ? 'e.g. AuthBridge / First Advantage' : type === CheckType.POLICE ? 'e.g. Shivajinagar Police Station' : 'e.g. TransUnion CIBIL'}
                value={editor.checkedByName}
                onChange={(e) => setEditor({ ...editor, checkedByName: e.target.value })} />
            </Field>
          )}
          {/*
            The report for THIS check — passed or not, it is kept with the result. Files already
            recorded against an earlier check are not offered: a re-check needs its own.
          */}
          {report && (
            <Field title="Report for this check" wide>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: report.pending.length > 0 ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
                  {report.pending.length > 0
                    ? `Uploaded (${report.pending.length} file${report.pending.length === 1 ? '' : 's'})${report.issuer ? ` — from ${report.issuer}` : ''}`
                    : report.earlier > 0
                      ? 'Upload the new report — the one on file belongs to the check recorded before'
                      : 'Not uploaded yet — required before a result can be recorded'}
                </span>
                {report.pending.length > 0 && report.doc?.id && (
                  <Attachments
                    documentId={report.doc.id}
                    filePaths={report.pending.map((f) => f.path)}
                    indexFor={(i) => report.pending[i].index ?? i}
                    canManage={canManage}
                    onRemoved={reload}
                    onError={setEditorErr}
                    documentLabel={report.label}
                    noun="report"
                  />
                )}
                {editor.checkedByName.trim()
                  ? <UploadButton requirement={report.requirement} onPick={(_req, file) => void attachBgvReport(file)} documentLabel={report.label} />
                  : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    {isBgv ? 'Name the agency above to upload its report.' : `Name the ${String(issuerLabel).toLowerCase()} above to upload the report.`}
                  </span>}
              </div>
            </Field>
          )}
          <Field title="Result">
            {/* The same words the chip will show once it is saved — see `verdictResultLabel`. */}
            <Select
              value={editor.verdict}
              onChange={(v) => setEditor({ ...editor, verdict: String(v) })}
              options={Object.values(BackgroundCheckVerdict).map((v) => ({
                value: v,
                label: verdictResultLabel(v),
              }))}
            />
          </Field>
          {(isBgv || type === CheckType.POLICE) && (
            <Field title="Risk">
              <Select
                value={editor.riskGrade}
                onChange={(v) => setEditor({ ...editor, riskGrade: String(v) })}
                options={[{ value: '', label: 'Not graded' }, ...Object.values(RiskGrade).map((v) => ({ value: v, label: RISK_LABELS[v] ?? v }))]}
              />
            </Field>
          )}
          {(isBgv || type === CheckType.CREDIT) && (
            <>
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
            </>
          )}
          <Field title="Checked on">
            <input style={fieldInput} type="date"
              value={editor.checkedOn}
              onChange={(e) => setEditor({ ...editor, checkedOn: e.target.value })} />
          </Field>
          <Field title={type === CheckType.IDENTITY ? 'What was re-checked, and what was found' : 'Findings'} wide>
            <input style={fieldInput}
              aria-label={type === CheckType.IDENTITY ? 'What was re-checked, and what was found' : 'Findings'}
              placeholder={type === CheckType.IDENTITY
                ? 'e.g. PAN and Aadhaar seen in original; both match the record'
                : 'What the check actually turned up. Leave empty if it turned up nothing.'}
              value={editor.findings}
              onChange={(e) => setEditor({ ...editor, findings: e.target.value })} />
          </Field>
        </Editor>
        );
      })()}

      {editor?.kind === 'reference' && (
        <Editor
          error={editorErr}
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
              options={relationshipOptions(editor.relationship)}
            />
          </Field>
          <Field title="Phone">
            <input style={fieldInput} inputMode="tel" value={editor.phone}
              onChange={(e) => setEditor({ ...editor, phone: e.target.value })} />
          </Field>
          <Field title="Email (optional)">
            {/* `inputMode`, not `type="email"`: this dialog is a <form>, and a typed email box
                hands a mistyped address to the browser's own validation bubble — which blocks the
                save before ours runs and says nothing in this app's words. The phone keyboard is
                the same either way. */}
            <input style={fieldInput} inputMode="email" autoCapitalize="none" autoCorrect="off"
              aria-label="Email of the reference" value={editor.email}
              onChange={(e) => setEditor({ ...editor, email: e.target.value })} />
          </Field>
        </Editor>
      )}

      {editor?.kind === 'identity' && (() => {
        /*
          ASK FOR WHAT IS ON THE PAPER, AND NOTHING ELSE.

          This form asked all eight identity documents for a number and an "Expires" date. Six of
          them never expire — a PAN, an Aadhaar and a Voter ID are issued once — and an address
          proof, usually an electricity bill, has no number anybody would call a document number.
          A reviewer holding a PAN card and looking at a box marked "Expires" either invents
          something or stops trusting the form, and the second costs more: the next box they skip
          is the one that mattered.
        */
        const facts = identityDocumentFacts(editor.requirement);
        /*
          THE SAME RULE THE SERVER APPLIES, ASKED BEFORE THE ROUND TRIP.

          A PAN and an Aadhaar both carry a check digit, and the server refuses a number whose
          check digit does not match — correctly, because a mistyped Aadhaar that still has twelve
          digits is indistinguishable from a real one afterwards, and this number is exactly what a
          human is later asked to check a scan against. Saying so while the number is still being
          typed turns a failed save into a caught typo.

          Advisory only where the rule is not certain: nothing is blocked except the two formats
          this app can genuinely test.
        */
        const typed = editor.documentNumber.trim();
        const numberProblem = !typed ? null
          : editor.requirement === 'PAN_CARD' && !isValidPan(typed.toUpperCase())
            ? 'That is not a valid PAN — it should be ten characters, like ABCDE1234F.'
            : (editor.requirement === 'AADHAAR_FRONT' || editor.requirement === 'AADHAAR_BACK')
              && /^\d{12}$/.test(typed) && !isValidAadhaar(typed)
              ? 'Those twelve digits do not check out — one of them has been misread. Please read the number off the document again.'
              : null;
        return (
          <Editor
            title={facts.numberLabel ? `${editor.label} — ${facts.numberLabel.toLowerCase()}` : editor.label}
            note="Saving replaces the stored number and clears any verification, because somebody checked the old number against the original."
            onCancel={closeEditor}
            onSave={saveEditor}
            saveLabel="Save"
            busy={busy}
            saveDisabled={!!numberProblem}
            error={editorErr ?? numberProblem}
          >
            {facts.numberLabel ? (
              <Field
                title={facts.numberLabel}
                hint={facts.numberHint
                  ? `${facts.numberHint} The stored one is covered on screen, so this box starts empty.`
                  : 'Type it from the document itself — the stored one is covered on screen, so this box starts empty.'}
                wide
              >
                <input style={fieldInput} autoFocus value={editor.documentNumber}
                  onChange={(e) => setEditor({ ...editor, documentNumber: e.target.value })} />
              </Field>
            ) : (
              <Field title="This document has no number" wide>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  An address proof is judged on the address printed on it and how recent it is,
                  which is recorded when it is verified.
                </span>
              </Field>
            )}
            {facts.expires && (
              <Field title="Expires" hint="The valid-until date printed on the document.">
                <input style={fieldInput} type="date" value={editor.expiryDate}
                  onChange={(e) => setEditor({ ...editor, expiryDate: e.target.value })} />
              </Field>
            )}
          </Editor>
        );
      })()}

      {data.openIssues.length > 0 && (
        <Notice
          tone="warning"
          style={{ marginBottom: '14px' }}
          title={`${counted(data.openIssues.length, 'cell')} from the roster import could not be read for this person.`}
        >
          <div style={{ marginTop: '6px' }}>
            {data.openIssues.map((i) => (
              <div key={i.id} style={{ marginBottom: '3px' }}>
                <code style={{ fontSize: 'var(--text-xs)' }}>{i.sourceColumn}</code>{' — '}
                {i.reason} Original text: “{i.rawValue}”.
              </div>
            ))}
          </div>
        </Notice>
      )}

      {section === 'checks' && (
        <>
      {/*
        Parked for not passing. The failed check and its report stay on file; re-verification is a
        new check with a new report, recorded once they are back in background verification.
      */}
      {onReopenBackgroundVerification && (
        <Notice tone="warning" style={{ marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <span>
              Background verification was not passed
              {check ? ` (${verdictResultLabel(check.verdict)}${check.checkedOn ? `, ${fmtDate(check.checkedOn)}` : ''})` : ''}.
              {' '}That check and its report stay on the record. If the agency verifies them again,
              re-open background verification and record the new check with its report.
            </span>
            <LinkButton onClick={onReopenBackgroundVerification}>Re-open background verification</LinkButton>
          </div>
        </Notice>
      )}
      <Section
        title="Background check"
        icon={check && verdictTone(check.verdict) === 'var(--danger)' ? ShieldAlert : ShieldCheck}
        style={{ marginBottom: '14px' }}
        action={canManage ? (
          <LinkButton
            icon={<Plus size={11} />}
            onClick={() => openCheckEditor()}
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
              <div style={label}>Result</div>
              <VerdictChip size="md" verdict={check.verdict} />
            </div>
            {check.riskGrade && (
              <div><div style={label}>Risk</div><div style={{ fontSize: 'var(--text-sm)' }}>{RISK_LABELS[check.riskGrade] ?? humanizeEnum(check.riskGrade)}</div></div>
            )}
            {check.cibilBand && (
              <div>
                <div style={label}>Credit</div>
                <div style={{ fontSize: 'var(--text-sm)' }}>
                  {CIBIL_LABELS[check.cibilBand] ?? humanizeEnum(check.cibilBand)}
                  {check.cibilScore ? ` (${check.cibilScore})` : ''}
                </div>
              </div>
            )}
            <div><div style={label}>Checked on</div><div style={{ fontSize: 'var(--text-sm)' }}>{fmtDate(check.checkedOn) || '—'}</div></div>
            {check.checkedByName && (
              <div><div style={label}>Background check agency</div><div style={{ fontSize: 'var(--text-sm)' }}>{check.checkedByName}</div></div>
            )}
            {check.verdict !== BackgroundCheckVerdict.NOT_CHECKED && (
              <div>
                <div style={label}>Report</div>
                <CheckReport files={check.reportFiles ?? []} documentPaths={bgvReport?.filePaths ?? []} onError={setErr} />
              </div>
            )}
            {check.findings && (
              <div style={{ flexBasis: '100%' }}>
                <div style={label}>Findings</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{check.findings}</div>
              </div>
            )}
          </div>
        )}

        {/*
          A report uploaded whose result is not recorded yet — the next check's evidence, still
          removable because nothing rests on it. Once its result is recorded it moves onto that
          check (above, or in the list below) and is kept there for good.
        */}
        {bgvPending.length > 0 && (
          <div style={{
            marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--border-hair)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px',
          }}>
            <div>
              <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--warning)' }}>
                Report uploaded — result not recorded yet
              </div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: '2px' }}>
                {counted(bgvPending.length, 'file')}{bgvReportIssuer ? ` from ${bgvReportIssuer}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {bgvReport?.id && (
                <Attachments
                  documentId={bgvReport.id}
                  filePaths={bgvPending.map((f) => f.path)}
                  indexFor={(i) => bgvPending[i].index ?? i}
                  canManage={canManage}
                  onRemoved={reload}
                  onError={setErr}
                  documentLabel="Background verification report"
                  noun="report"
                />
              )}
              {canManage && <LinkButton onClick={() => openCheckEditor()}>Record its result</LinkButton>}
            </div>
          </div>
        )}

        {/*
          Every other check on file — earlier background checks and every re-check over time
          (police, credit, identity), newest first, each with its own report and, for an adverse
          re-check on somebody working, what the senior decided.
        */}
        {data.backgroundChecks.filter((c) => c.id !== check?.id).length > 0 && (
          <DataTable
            density="compact"
            minWidth={false}
            rows={data.backgroundChecks.filter((c) => c.id !== check?.id)}
            rowKey={(c) => c.id}
            columns={[
              { key: 'date', header: 'Date', render: (c) => <>{fmtDate(c.checkedOn) || '—'}</> },
              { key: 'type', header: 'Check', render: (c) => <>{CHECK_TYPE_LABELS[(c.checkType ?? CheckType.BGV) as CheckType]}</> },
              { key: 'verdict', header: 'Result', render: (c) => <VerdictChip verdict={c.verdict} /> },
              { key: 'risk', header: 'Risk', render: (c) => <>{c.riskGrade ? (RISK_LABELS[c.riskGrade] ?? humanizeEnum(c.riskGrade)) : '—'}</> },
              { key: 'agency', header: 'Agency', render: (c) => <>{c.checkedByName || '—'}</> },
              // Free prose written by whoever did the check — the one column here that is a
              // paragraph rather than a value, so it wraps instead of stretching the table.
              { key: 'findings', header: 'Findings', wrap: true, render: (c) => <>{c.findings || '—'}</> },
              // The report each earlier result was read from — a "not passed" keeps its report.
              {
                key: 'report', header: 'Report',
                render: (c) => (c.verdict === BackgroundCheckVerdict.NOT_CHECKED || (c.checkType ?? CheckType.BGV) === CheckType.IDENTITY
                  ? <>—</>
                  : <CheckReport files={c.reportFiles ?? []} documentPaths={reportFor((c.checkType ?? CheckType.BGV) as CheckType)?.doc?.filePaths ?? []} onError={setErr} />),
              },
              {
                key: 'decision', header: 'Decision', wrap: true,
                render: (c) => (c.reviewStatus === 'PENDING'
                  ? <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Awaiting a senior</span>
                  : c.reviewStatus
                    ? <>{c.reviewStatus === 'KEPT' ? 'Kept working' : 'Suspended'}{c.reviewReason ? ` — ${c.reviewReason}` : ''}</>
                    : <>—</>),
              },
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
            fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.5,
          }}>
            <Lock size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>
              Checks and their reports cannot be edited or deleted — each one is the record of what
              was found on the day it was done. If this is wrong or out of date, or the person has
              been verified again, record a new check with its report: it becomes the operative one
              and this drops into the list above.
            </span>
          </div>
        )}
      </Section>

      {/*
        RE-CHECKS OVER TIME (2026-09-23). Background, police, credit and identity documents are
        re-checked on the schedule in Settings; this says where each one stands, and — when one came
        back adverse — holds the decision a senior has to take.
      */}
      {data.compliance && (data.compliance.rechecked || data.compliance.hold) && (() => {
        const compliance = data.compliance!;
        const holdCheck = compliance.hold ? data.backgroundChecks.find((c) => c.id === compliance.hold!.checkId) : null;
        const mayDecide = !!compliance.hold && canApprove && holdCheck?.createdBy !== currentUserId;
        const decide = async (decision: CheckReviewDecision) => {
          if (!compliance.hold) return;
          if (reviewText.trim().length < 10) { setReviewErr('Say why — it is kept on their record with the decision.'); return; }
          setBusy(true); setReviewErr(null);
          try {
            await api.request(`/assayers/${assayerId}/checks/${compliance.hold.checkId}/review`, {
              method: 'POST', body: JSON.stringify({ decision, reason: reviewText.trim() }),
            });
            setReviewText('');
            toast({
              type: 'success',
              title: decision === CheckReviewDecision.KEEP ? 'Kept working' : 'Suspended',
              message: decision === CheckReviewDecision.KEEP ? 'The hold on new work is lifted.' : 'They are suspended; the reason is on their record.',
            });
            reload();
          } catch (e) { setReviewErr(userMessage(e)); } finally { setBusy(false); }
        };
        const tone: Record<string, string> = { OK: 'var(--success)', DUE_SOON: 'var(--accent)', DUE: 'var(--warning)', BLOCKED: 'var(--danger)' };
        return (
          <Section
            title="Re-checks over time"
            icon={compliance.blockers.length > 0 ? ShieldAlert : ShieldCheck}
            hint="Each check repeats on the schedule set in Settings. Overdue past the grace period, or adverse, holds them from new work — work already assigned continues."
            style={{ marginBottom: '14px' }}
          >
            {compliance.hold && (
              <Notice tone="warning" style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <span>
                    <strong>{CHECK_TYPE_LABELS[compliance.hold.checkType as CheckType]}</strong> came back{' '}
                    {(VERDICT_LABELS[compliance.hold.verdict] ?? compliance.hold.verdict).toLowerCase()}
                    {holdCheck?.findings ? `: ${holdCheck.findings}` : ''}. Held from new work since {compliance.hold.since} until a senior decides.
                  </span>
                  {mayDecide ? (
                    <>
                      <textarea
                        aria-label="Why — kept on their record"
                        value={reviewText}
                        maxLength={2000}
                        onChange={(e) => { setReviewText(e.target.value); setReviewErr(null); }}
                        placeholder="Why you are keeping them working, or suspending them"
                        style={{ ...fieldInput, minHeight: '56px', resize: 'vertical' }}
                      />
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button type="button" className="btn btn-primary" disabled={busy} style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}
                          onClick={() => void decide(CheckReviewDecision.KEEP)}>Keep them working</button>
                        <button type="button" className="btn" disabled={busy}
                          style={{ fontSize: 'var(--text-xs)', padding: '6px 12px', background: 'var(--danger)', color: '#fff', borderColor: 'var(--danger)' }}
                          onClick={() => void decide(CheckReviewDecision.SUSPEND)}>Suspend them</button>
                      </div>
                      {reviewErr && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{reviewErr}</div>}
                    </>
                  ) : (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      {canApprove ? 'You recorded this check, so somebody else has to decide it.' : 'A senior decides this — keep them working, or suspend them.'}
                    </span>
                  )}
                </div>
              </Notice>
            )}
            {compliance.standings.length > 0 && (
              <DataTable
                density="compact"
                minWidth={false}
                rows={compliance.standings}
                rowKey={(r) => r.type}
                columns={[
                  { key: 'check', header: 'Check', render: (r) => <>{CHECK_TYPE_LABELS[r.type]}</> },
                  {
                    key: 'last', header: 'Last done',
                    render: (r) => (r.lastCheckedOn
                      ? <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>{fmtDate(r.lastCheckedOn)}{r.lastVerdict && <VerdictChip verdict={r.lastVerdict} />}</span>
                      : <span style={{ color: 'var(--text-muted)' }}>Never</span>),
                  },
                  { key: 'due', header: 'Next due', render: (r) => <>{fmtDate(r.dueOn)}{r.because ? <span style={{ color: 'var(--text-muted)' }}> · {r.because}</span> : null}</> },
                  {
                    key: 'status', header: 'Where it stands',
                    render: (r) => <span style={{ fontWeight: 700, color: tone[r.status] }}>{RECHECK_STATUS_LABELS[r.status]}</span>,
                  },
                  ...(canManage ? [{
                    key: 'act', header: '',
                    render: (r: RecheckStanding) => <LinkButton onClick={() => openCheckEditor(r.type)}>Record</LinkButton>,
                  }] : []),
                ]}
              />
            )}
          </Section>
        );
      })()}

      <Section
        title="Standing with each bank"
        icon={Building2}
        count={data.empanelments.length}
        hint="Whether each bank accepts this person. One answer per bank — being active for one says nothing about another."
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
            Add a bank
          </LinkButton>
        ) : undefined}
      >
        {data.empanelments.length === 0 ? (
          <Empty>No standing with any bank has been recorded.</Empty>
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
              { key: 'client', header: 'Bank', render: (e) => <>{e.client?.name ?? '—'}</> },
              {
                key: 'standing',
                header: 'Standing',
                render: (e) => (
                  <span style={{ fontWeight: 600, color: STANDING_STANCE_TONE[standingStance(e.status)].fg }}>
                    {STANDING_LABELS[e.status] ?? humanizeEnum(e.status)}
                  </span>
                ),
              },
              { key: 'decided', header: 'Decided', render: (e) => <>{fmtDate(e.decidedAt) || '—'}</> },
              { key: 'why', header: 'Why', wrap: true, render: (e) => <>{e.statusReason || e.documentsOutstanding || '—'}</> },
              ...(canManage ? [{
                key: 'act',
                header: '',
                render: (e: typeof data.empanelments[number]) => {
                  if (HARD_BLOCKED_STANDINGS.has(e.status)) {
                    // Said on the row, not in a tooltip: a clerk on a tablet cannot hover, and
                    // "why is there no Change button here" is the question this answers.
                    return (
                      <span
                        data-testid="hard-block-tag"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: '4px',
                          fontSize: 'var(--text-2xs)', color: 'var(--text-muted)',
                        }}
                      >
                        <Lock size={11} style={{ flexShrink: 0 }} />
                        <span>
                          <strong style={{ color: 'var(--text-secondary)' }}>Final</strong>
                          {' '}— this bank&apos;s decision can&apos;t be changed here
                        </span>
                      </span>
                    );
                  }
                  return (
                    <RowActions>
                      <LinkButton onClick={() => setEditor({
                        kind: 'standing', adding: false,
                        clientId: e.clientId, clientName: e.client?.name ?? 'this client',
                        status: e.status, statusReason: e.statusReason ?? '',
                      })}>
                        Change
                      </LinkButton>
                    </RowActions>
                  );
                },
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
          <div style={{ marginTop: '10px', fontSize: 'var(--text-xs)', color: STANDING_STANCE_TONE.refused.fg }}>
            Not to be planned for {unplannable.refused} — that decision has been taken.
          </div>
        )}
        {unplannable.notReady && (
          <div style={{ marginTop: '10px', fontSize: 'var(--text-xs)', color: STANDING_STANCE_TONE.notReady.fg }}>
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
            onClick={() => setEditor({ kind: 'reference', fullName: '', relationship: '', phone: '', email: '' })}
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
              { key: 'phone', header: 'Phone', render: (r) => <>{referencePhoneForDisplay(r.phone) || '—'}</> },
              { key: 'email', header: 'Email', wrap: true, render: (r) => <>{r.email || '—'}</> },
              {
                key: 'checked',
                header: 'Spoken to',
                render: (r) => (r.checkedAt
                  ? <span style={{ color: 'var(--success)' }}><Check size={12} style={{ verticalAlign: '-2px' }} /> {fmtDate(r.checkedAt)}</span>
                  : <span style={{ color: 'var(--text-muted)' }}>Not yet</span>),
              },
              {
                key: 'told',
                header: 'Told to expect a call',
                wrap: true,
                render: (r) => <>{referenceNoticeLine(r)}</>,
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
                      ? <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>Called</span>
                      : <LinkButton onClick={() => markChecked(r)}>Record call</LinkButton>}
                    <LinkButton
                      onClick={() => setEditor({
                        kind: 'reference',
                        id: r.id,
                        fullName: r.fullName ?? '',
                        relationship: r.relationship ?? '',
                        phone: r.phone ?? '',
                        email: r.email ?? '',
                      })}
                    >
                      Change
                    </LinkButton>
                    {!r.checkedAt && (r.email || r.phone) && (
                      <LinkButton onClick={() => void notifyReferee(r)}>
                        {r.notifiedAt ? 'Tell them again' : 'Tell them'}
                      </LinkButton>
                    )}
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
        <div style={{ ...label, marginBottom: '8px' }}>Identity and bank</div>
        <DataTable
          density="compact"
          minWidth={false}
          rows={paperwork.identity}
          rowKey={(d) => d.requirement}
          columns={[
            // `wrap` because `DataTable` makes every cell `nowrap` unless told otherwise, and
            // "Police verification certificate" on one line was half of what pushed this table
            // past the drawer's edge. `minWidth={false}` only removed the floor; it never let
            // a long label break.
            { key: 'doc', header: 'Document', wrap: true, render: (d) => <>{d.label}</> },
            {
              key: 'number',
              header: 'Number',
              render: (d) => (d.documentNumber
                ? <code style={{ fontSize: 'var(--text-xs)' }}>{d.documentNumber}</code>
                : d.requirement === 'BANK_PASSBOOK'
                  // The number a passbook is checked against is the record's account, which is set
                  // on the record's own bank details — not typed here.
                  ? <span style={{ color: 'var(--text-muted)' }}>No account on the record</span>
                  : <span style={{ color: 'var(--text-muted)' }}>—</span>),
            },
            {
              key: 'expires',
              header: 'Expires',
              /*
                A dash reads as "this is missing". For a PAN card, an Aadhaar or a Voter ID there is
                nothing to miss — they are issued once and never run out — so the column says that
                instead of sending a clerk hunting the card for a date it does not print.
              */
              render: (d) => {
                if (d.expiryDate) return <>{fmtDate(d.expiryDate)}</>;
                return (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {identityDocumentFacts(d.requirement).expires ? 'Not recorded' : 'Does not expire'}
                  </span>
                );
              },
            },
            { key: 'checked', header: 'Status', render: (d) => <VerificationChip status={d.verificationStatus} /> },
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
                  {/* Not for the passbook: its number is the record's account, changed on the bank details. */}
                  {d.identity && <LinkButton onClick={() => setEditor({
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
                  </LinkButton>}
                  {d.id && d.documentNumber && d.verificationStatus !== 'VERIFIED' && (
                    <>
                      <LinkButton
                        onClick={() => setPrintedTarget(d)}
                        disabled={reviewLocked}
                        label={reviewLocked ? `Verify — ${reviewLockHint}` : undefined}
                      >
                        Verify
                      </LinkButton>
                      <LinkButton
                        onClick={() => setRejectTarget(d)}
                        disabled={reviewLocked}
                        label={reviewLocked ? `Send back — ${reviewLockHint}` : undefined}
                      >
                        Send back
                      </LinkButton>
                    </>
                  )}
                  {/* Accepted, so locked against them: this is the only way to ask for it again. */}
                  {d.id && d.verificationStatus === 'VERIFIED' && (
                    <LinkButton onClick={() => setReuploadTarget(d)} label={`Ask for ${d.label} again`}>
                      Ask to re-upload
                    </LinkButton>
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
            { key: 'doc', header: 'Document', wrap: true, render: (d) => <>{d.label}</> },
            {
              key: 'scan',
              header: 'Scan',
              // The scan itself where there is one; the tick only where somebody said a copy
              // arrived without attaching it. A column that can show the document should.
              render: (d) => ((d.filePaths ?? []).length > 0
                // A background check's report is removed, if at all, on the Background tab, where it
                // is plain which files a recorded check rests on (those cannot be removed).
                ? <Attachments documentId={d.id} filePaths={d.filePaths} canManage={canManage && !checkTypeForReport(d.requirement)} onRemoved={reload} onError={setErr} documentLabel={d.label} />
                : <NoScan claimed={d.softCopyReceived} />),
            },
            { key: 'hard', header: 'Hard copy', render: (d) => <>{yesNo(d.hardCopyReceived)}</> },
            {
              key: 'where',
              header: 'Where',
              wrap: true,
              render: (d) => (canManage
                ? <LocationPicker value={d.hardCopyLocation} onChange={(v) => setWhere(d.requirement, v)} documentLabel={d.label} />
                : <>{d.hardCopyLocation || '—'}</>),
            },
            ...(canManage ? [{
              key: 'act',
              header: '',
              render: (d: typeof paperwork.joining[number]) => (
                <RowActions>
                  {checkTypeForReport(d.requirement)
                    ? (checkTypeForReport(d.requirement) !== CheckType.BGV && !data?.compliance?.rechecked
                      // Kept, and used for their first re-check of this kind once they are working.
                      ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Used for their first re-check once they are working</span>
                      // Uploaded with the agency that produced it, which is asked on the Background tab.
                      : onGoToChecks
                        ? <LinkButton onClick={onGoToChecks}>Upload on the Background tab</LinkButton>
                        : <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Uploaded on the Background tab</span>)
                    : <UploadButton requirement={d.requirement} onPick={attach} documentLabel={d.label} />}
                  {/* The ID-card photo locks against them once they are approved; only HR reopens it,
                      and not while an earlier request is still waiting on them. */}
                  {d.requirement === OnboardingDocument.PHOTOGRAPH && photoLocked
                    && ((d.filePaths ?? []).length > 0 || !!person?.photograph) && d.verificationStatus !== 'REJECTED' && (
                    <LinkButton onClick={() => setReuploadTarget(d)} label="Ask for their photo again">
                      Ask to re-upload
                    </LinkButton>
                  )}
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
