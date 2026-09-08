import React, { useEffect, useMemo, useState } from 'react';
import { Paperclip, Trash2, Check, FileText, IdCard, ShieldCheck } from 'lucide-react';
import { SCAN_UPLOAD_MIME_TYPES, SCAN_UPLOAD_ACCEPT, DEFAULT_MAX_UPLOAD_MB } from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { AlertBanner, Select, useConfirm, useToast } from '../../../components/ui';
import { Editor } from '../hr-ui';
import { looksLikeMask } from '../assayer-shared';
import { humanize } from '../AssayerForms';
import type { Dossier, DossierDocument } from './useRegistration';

/**
 * The papers the person brought to the desk, scanned into their file here and now.
 *
 * Everything this step talks to already existed — `GET /assayers/:id/dossier` returns the full
 * twenty-one-item requirement list whether or not a single row is on file, and
 * `POST /assayers/:id/document/:requirement/file` has always taken the scan. What did not exist
 * was a moment in the working day when a person was expected to use them: they lived two tabs
 * deep on a record nobody opened until something went wrong, which is why 11,160 document rows
 * carry a "soft copy received" tick and no file at all. Putting them in the registration puts
 * them in front of the one person who is holding the papers.
 *
 * Three things are different from the tab this borrows from. The file input takes MULTIPLE files,
 * because the commonest requirement in the list is a card with two sides and a one-at-a-time
 * picker made the second side an act of discipline. The document number is typed inline rather
 * than in a pop-up, because `verifyDocument` refuses outright when it is blank — "there is nothing
 * to have checked against the original" — so a scan filed without one can never be verified, and
 * nothing on the old screen said that until somebody tried. And the check itself happens here, in
 * the same pass as the scan and the number, which only became possible once `verifyDocument`
 * learned to read a PAN or Aadhaar number from the person rather than from the document row where
 * it is always NULL.
 */

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)',
  padding: '12px 14px',
};

// `--bg-surface-2`, not `--bg-page`: this box sits inside a document's `cardStyle` card
// (`--bg-card`), which is the same colour as `--bg-page` in the dark themes — so the box read
// as part of the card rather than as something to type into.
const numberInputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '13px', fontFamily: 'monospace',
  background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', outline: 'none',
};

/**
 * The scans already on a document, as thumbnails you can open.
 *
 * The route needs an Authorization header, so a plain `<img src>` cannot fetch it — the bytes
 * come through `api.request` as a blob and become an object URL, the way every other protected
 * file in this app is read. Revoked on unmount, or the tab leaks a copy of every identity
 * document somebody scrolls past.
 */
const Scans: React.FC<{
  documentId: string | null;
  filePaths: string[];
  label: string;
  onChanged: () => void;
}> = ({ documentId, filePaths, label, onChanged }) => {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const { toast } = useToast();
  const fingerprint = filePaths.join('|');

  useEffect(() => {
    if (!documentId || filePaths.length === 0) { setUrls([]); return undefined; }
    let live = true;
    const made: string[] = [];
    Promise.all(filePaths.map((_, i) =>
      api.request<Blob>(`/assayers/document/${documentId}/file/${i}`, { raw: true })
        .then((b) => { const u = URL.createObjectURL(b); made.push(u); return u; })
        .catch(() => null),
    )).then((list) => { if (live) setUrls(list); }).catch(() => { if (live) setUrls([]); });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
    // `fingerprint` rather than the array: a new array identity on every dossier reload would
    // re-fetch and re-allocate every thumbnail on the page for no change at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, fingerprint]);

  const remove = async (index: number) => {
    if (!documentId) return;
    try {
      await api.request(`/assayers/document/${documentId}/file/${index}`, { method: 'DELETE' });
      onChanged();
    } catch (e) { toast({ type: 'error', message: userMessage(e) }); }
  };

  if (filePaths.length === 0) return null;
  // TIFF is deliberately not here: browsers cannot render it, so a TIFF page stays a download
  // link rather than a broken thumbnail.
  const isImage = (key: string) => /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(key);

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
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
              style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none', color: 'var(--accent-primary)', fontSize: '12px' }}
            >
              {url && isImage(key) ? (
                <img
                  src={url}
                  alt={`${label}, page ${i + 1}`}
                  style={{
                    width: '40px', height: '40px', objectFit: 'cover', borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-color)', display: 'block',
                  }}
                />
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Paperclip size={12} /> {url ? `Page ${i + 1}` : 'Loading…'}
                </span>
              )}
            </a>
            <button
              type="button"
              onClick={() => void remove(i)}
              aria-label={`Remove page ${i + 1} of ${label}`}
              title={`Remove page ${i + 1} of ${label}`}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '2px' }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        );
      })}
    </div>
  );
};

/**
 * One requirement: what it is, what is attached, and — for an identity document — its number.
 *
 * The number box saves on blur rather than behind a button. A clerk copying twelve digits off a
 * card and moving to the next card is not going to hunt for a save control, and the field it
 * writes is the same column the ID step writes, so leaving it unsaved would mean the two screens
 * disagree about the same person's Aadhaar.
 */

/** What a reviewer types off the card. Held per row until the verdict is sent with it. */
export interface PrintedValues {
  holderName: string;
  holderDateOfBirth: string;
  holderGender: string;
  holderGuardianName: string;
  holderAddress: string;
}

/** Why a scan was sent back, in the words the reviewer picks from. */
const REJECTION_LABELS: Record<string, string> = {
  ILLEGIBLE: 'Too blurred or dark to read',
  INCOMPLETE_CAPTURE: 'Part of the document is cut off',
  WRONG_DOCUMENT: 'This is a different document',
  NAME_MISMATCH: 'The name does not match the record',
  NUMBER_MISMATCH: 'The number does not match the record',
  EXPIRED: 'The document has expired',
  NOT_THE_PERSON: 'This does not belong to this person',
  ALTERED_OR_SUSPECT: 'The document looks altered',
};

// `--bg-surface-2`, not `--bg-page`: the modal panel itself renders at `--bg-card`, the same
// colour as `--bg-page` in the dark themes, so a field at the page colour disappeared into the
// dialog around it.
const modalFieldStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: '13px', fontFamily: 'inherit',
  background: 'var(--bg-surface-2)', color: 'var(--text-primary)',
  border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', outline: 'none',
  boxSizing: 'border-box',
};
const modalLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px',
};

/**
 * Which of the fixed reasons applies, and anything worth remembering about it — a small form now,
 * where this used to be a native `window.prompt` reading a numbered list back at whoever was
 * sending a scan back. The value still has to be one of the known set: it is translated and shown
 * to the appraiser as an instruction, so free text in ITS place would reach them as a blank space.
 * The note is different — it stays on this record, for whoever looks at it next, and is never
 * shown to the appraiser at all.
 *
 * Exported for the record's vetting tab, which sends scans back for the same reasons through the
 * same endpoint — one list of reasons, one dialog, two call sites.
 */
export const RejectDocumentModal: React.FC<{
  label: string;
  onCancel: () => void;
  onSubmit: (reason: string, note: string) => void;
}> = ({ label, onCancel, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  return (
    <Editor
      title={`Why is ${label} being sent back?`}
      intro="They are told this, on their phone, with what to do about it."
      onCancel={onCancel}
      onSave={() => onSubmit(reason, note)}
      // Not "Send it back" again — that is the row's own button, which stays on screen
      // behind this dialog, and two controls with one name is confusing to click and to
      // test alike. Matches "Yes, I checked it", this file's other confirm-and-go label.
      saveLabel="Yes, send it back"
      saveDisabled={!reason}
    >
      <div>
        <label style={modalLabelStyle}>Reason</label>
        {/* `Select` takes no `id`/`for`, so it is named directly rather than through the visual
            label above it — the same pattern `renderFormField`'s own place fields use. */}
        <Select
          value={reason}
          onChange={(v) => setReason(String(v))}
          options={Object.entries(REJECTION_LABELS).map(([value, text]) => ({ value, label: text }))}
          placeholder="-- Choose a reason --"
          aria-label="Why this document is being sent back"
        />
      </div>
      <div>
        <label htmlFor="reject-note" style={modalLabelStyle}>
          Note (optional — kept on the record, not shown to them)
        </label>
        <textarea
          id="reject-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Anything worth remembering about this, for whoever looks at this record next."
          style={{ ...modalFieldStyle, resize: 'vertical' }}
        />
      </div>
    </Editor>
  );
};

/**
 * Accepting a name that does not agree with the record, and saying why — a small form where this
 * used to be a native `window.prompt`. Wording kept as it was: a reviewer who has already read the
 * server's own refusal is being asked one question, not re-taught what it means.
 */
const NameMismatchModal: React.FC<{
  message: string;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}> = ({ message, onCancel, onSubmit }) => {
  const [why, setWhy] = useState('');
  const ready = why.trim().length >= 10;
  return (
    <Editor
      title="The name does not match"
      intro={message}
      onCancel={onCancel}
      onSave={() => onSubmit(why.trim())}
      saveLabel="Verify anyway"
      saveDisabled={!ready}
      note={!ready ? 'At least 10 characters, so the reason is actually useful to whoever reads it later.' : undefined}
    >
      <div>
        <label htmlFor="name-mismatch-why" style={modalLabelStyle}>If it is the same person, say why:</label>
        <textarea
          id="name-mismatch-why"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          rows={3}
          placeholder="e.g. Maiden name on the card, married name already on the record"
          style={{ ...modalFieldStyle, resize: 'vertical' }}
        />
      </div>
    </Editor>
  );
};

/** "PDF or an image (JPEG/PNG/WebP/HEIC/TIFF/BMP/GIF)" — the same words `assertUploadAllowed` refuses with on the server, so a clerk never learns two different names for what this box takes. */
const HUMAN_SCAN_TYPES = 'PDF or an image (JPEG/PNG/WebP/HEIC/TIFF/BMP/GIF)';

/**
 * The same check `assertUploadAllowed` runs server-side, run here first so a clerk on a slow
 * connection learns a scan is the wrong kind of file before waiting for the upload to fail. The
 * server stays the authority — this is a courtesy, not a second copy of the rule with its own idea
 * of what is allowed, which is why it shares the one accept-list (`SCAN_UPLOAD_MIME_TYPES`) rather
 * than declaring its own.
 *
 * A blank declared type is let through deliberately. Android and older browsers leave `type` empty
 * for a HEIC/HEIF photo often enough that refusing it here would bounce an ordinary phone photo the
 * server's own filename-extension fallback would have accepted — only a type that positively names
 * something else is refused before the request is even made.
 */
function scanUploadProblem(file: File): string | null {
  const type = (file.type || '').toLowerCase();
  if (type && !SCAN_UPLOAD_MIME_TYPES.includes(type)) {
    return `is a "${type}" file — this only takes ${HUMAN_SCAN_TYPES}.`;
  }
  const maxBytes = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  if (file.size > maxBytes) {
    return `is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${DEFAULT_MAX_UPLOAD_MB} MB limit.`;
  }
  return null;
}

const PRINTED_LABELS: Record<keyof PrintedValues, string> = {
  holderName: 'Name exactly as printed',
  holderDateOfBirth: 'Date of birth on the card',
  holderGender: 'Gender',
  holderGuardianName: "Father's / guardian's name",
  holderAddress: 'Address as printed',
};

const PRINTED_KEYS: Array<[keyof PrintedValues, 'name' | 'dateOfBirth' | 'gender' | 'guardianName' | 'address']> = [
  ['holderName', 'name'],
  ['holderDateOfBirth', 'dateOfBirth'],
  ['holderGender', 'gender'],
  ['holderGuardianName', 'guardianName'],
  ['holderAddress', 'address'],
];

/**
 * The details a reviewer reads off the document, and the only place in this system where identity
 * data is not self-asserted.
 *
 * Everything else about a person came from a spreadsheet or from the person. These come from a card
 * somebody is holding, which is what makes the name comparison mean anything: until the document's
 * name was written down, the record's name could not be checked against it, because there was
 * nothing to check it against.
 */
const PrintedDetails: React.FC<{
  prints: NonNullable<DossierDocument['prints']>;
  value: PrintedValues;
  onChange: (next: PrintedValues) => void;
  requirement: string;
}> = ({ prints, value, onChange, requirement }) => (
  <div style={{ marginTop: '10px', display: 'grid', gap: '8px' }}>
    <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)' }}>
      What the document says
    </div>
    {PRINTED_KEYS.filter(([, flag]) => prints[flag]).map(([key]) => (
      <div key={key}>
        <label
          htmlFor={`printed-${requirement}-${key}`}
          style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '3px' }}
        >
          {PRINTED_LABELS[key]}
        </label>
        <input
          id={`printed-${requirement}-${key}`}
          type={key === 'holderDateOfBirth' ? 'date' : 'text'}
          value={value[key]}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          placeholder={key === 'holderName' ? 'Copy it letter for letter, initials included' : undefined}
          style={numberInputStyle}
        />
      </div>
    ))}
  </div>
);

const RequirementRow: React.FC<{
  doc: DossierDocument;
  assayerId: string;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
  onVerify: (doc: DossierDocument, printed: PrintedValues) => void;
  onReject: (doc: DossierDocument) => void;
}> = ({ doc, assayerId, onChanged, onBusy, onVerify, onReject }) => {
  /**
   * What is on file, and whether it is covered.
   *
   * The dossier masks `documentNumber` — an identity document's number is written through to the
   * person's own PAN or Aadhaar column (`NUMBER_LIVES_ON_THE_PERSON` in the backend), so it is
   * one of the three things this application does not print in full. The box therefore starts
   * empty when a covered number is on file, and the covered form is shown above it instead: a
   * box holding `******234F` invites a one-character correction that silently replaces a real KYC
   * identifier with a mask, which the server refuses and which no screen would have caught.
   */
  const onFile = doc.documentNumber ?? '';
  const covered = looksLikeMask(onFile);
  const boxFor = (value: string) => (looksLikeMask(value) ? '' : value);

  const [number, setNumber] = useState(() => boxFor(onFile));
  /**
   * What the card says, held here until the reviewer presses the button.
   *
   * Not saved on blur like the number is. The number is a fact about the record that the ID step
   * also writes; these are an attestation, and they mean "I read this off the document in my hand"
   * — so they are sent with the verdict, in one action, rather than accumulating on a row nobody
   * has yet vouched for.
   */
  const [printed, setPrinted] = useState({
    holderName: doc.holderName ?? '',
    holderDateOfBirth: (doc.holderDateOfBirth ?? '').slice(0, 10),
    holderGender: doc.holderGender ?? '',
    holderGuardianName: doc.holderGuardianName ?? '',
    holderAddress: doc.holderAddress ?? '',
  });
  const [uploading, setUploading] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  /** True while a drag carrying files is over this row's picker — a visual target, nothing more. */
  const [dragOver, setDragOver] = useState(false);
  const { toast } = useToast();

  // The dossier is the truth: a reload after somebody else edited this number, or after the ID
  // step wrote the same column, must show through rather than being hidden by stale local state.
  useEffect(() => { setNumber(boxFor(doc.documentNumber ?? '')); }, [doc.documentNumber]);

  const attach = async (files: FileList | File[]) => {
    /**
     * Checked before a single byte goes out, against the SAME accept-list and size cap
     * `assertUploadAllowed` enforces server-side — see `scanUploadProblem`. The server stays the
     * authority (a file that passes here can still be refused there, and is), but a clerk on a
     * slow office connection learns a spreadsheet was picked by mistake before waiting out an
     * upload that was always going to fail.
     */
    const all = Array.from(files);
    const problems: string[] = [];
    const ok: File[] = [];
    for (const file of all) {
      const problem = scanUploadProblem(file);
      if (problem) problems.push(`"${file.name}" ${problem}`); else ok.push(file);
    }
    setRowError(problems.length > 0 ? problems.join(' ') : null);
    if (ok.length === 0) return;

    setUploading(true);
    onBusy(true);
    try {
      /**
       * One at a time, deliberately.
       *
       * `attachFile` does `row.filePaths = [...(row.filePaths ?? []), key]` and saves — a
       * read-modify-write on one row. Firing both sides of an Aadhaar card at once means the
       * second read happens before the first write lands, and the file that arrives second
       * replaces rather than joins the first. Uploading a card and finding one side of it is a
       * failure nobody would think to look for.
       */
      for (const file of ok) {
        const body = new FormData();
        body.append('file', file);
        await api.request(`/assayers/${assayerId}/document/${doc.requirement}/file`, { method: 'POST', body });
      }
      onChanged();
    } catch (e) {
      setRowError(userMessage(e));
    } finally {
      setUploading(false);
      onBusy(false);
    }
  };

  const saveNumber = async () => {
    const next = number.trim();
    if (next === onFile) return;
    /**
     * An empty box beside a covered number means "I did not touch it", not "delete it".
     *
     * This save fires on blur, so simply tabbing through the row would otherwise send
     * `documentNumber: ''` and wipe an Aadhaar off the person's record — the exact accident the
     * empty box was introduced to prevent, arriving through the back door.
     */
    if (!next && covered) return;
    if (looksLikeMask(next)) {
      setRowError(`That is the covered form of the number, not the number. Type it from the ${doc.label.toLowerCase()} itself.`);
      return;
    }
    onBusy(true);
    setRowError(null);
    try {
      await api.request(`/assayers/${assayerId}/document/${doc.requirement}`, {
        method: 'PUT', body: JSON.stringify({ documentNumber: next }),
      });
      onChanged();
    } catch (e) {
      setRowError(userMessage(e));
      toast({ type: 'error', title: `Could not save the ${doc.label} number`, message: userMessage(e) });
    } finally { onBusy(false); }
  };

  const scans = doc.filePaths.length;
  const verified = doc.verificationStatus === 'VERIFIED';

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{doc.label}</div>
          <div style={{ fontSize: '12px', color: scans > 0 ? 'var(--success)' : 'var(--text-muted)', marginTop: '2px' }}>
            {scans === 0
              ? 'Nothing scanned yet'
              : `${scans} ${scans === 1 ? 'page' : 'pages'} on file${verified ? ' · checked against the original' : ''}`}
          </div>
        </div>
        {/*
          Also a drop target now — a dashed accent outline is the only tell, since the label was
          already the obvious place to put a file. `scanUploadProblem` runs on whatever lands here
          exactly as it does on a picked file, so a dragged spreadsheet is refused the same way.
        */}
        <label
          className="btn btn-secondary"
          style={{
            fontSize: '12px', padding: '6px 12px', cursor: uploading ? 'wait' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: '6px', width: 'auto',
            outline: dragOver ? '2px dashed var(--accent)' : undefined, outlineOffset: '2px',
          }}
          onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (uploading) return;
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) void attach(files);
          }}
        >
          <Paperclip size={13} />
          {uploading ? 'Adding…' : scans > 0 ? 'Add another page' : 'Add scan or photo'}
          <input
            type="file"
            multiple
            accept={SCAN_UPLOAD_ACCEPT}
            // Phone browsers offer the camera directly alongside the gallery when a capture hint
            // is present, rather than only ever opening the file picker — the same one-tap photo
            // a native app would offer, on a form that otherwise has no camera of its own.
            capture="environment"
            style={{ display: 'none' }}
            disabled={uploading}
            onChange={(e) => {
              const files = e.target.files;
              // Cleared before the request so re-picking the same file — a re-scan of a page that
              // came out dark — still fires a change event. Without it the second attempt does
              // nothing at all and looks like the upload silently failed.
              const chosen = files && files.length > 0 ? files : null;
              e.target.value = '';
              if (chosen) void attach(chosen);
            }}
          />
        </label>
      </div>

      {doc.identity && (
        <div style={{ marginTop: '10px' }}>
          <label
            htmlFor={`docnum-${doc.requirement}`}
            style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}
          >
            Number printed on it
          </label>
          {covered && (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
              On file: <span style={{ fontFamily: 'monospace' }}>{onFile}</span> — kept in full and
              encrypted, shown here as its last few digits. Leave the box empty to keep it.
            </div>
          )}
          <input
            id={`docnum-${doc.requirement}`}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onBlur={() => void saveNumber()}
            placeholder={covered ? 'Type a new number to replace it' : 'Type the number written on the document'}
            style={numberInputStyle}
          />
          {!number.trim() && !covered && (
            <div style={{ fontSize: '12px', color: 'var(--warning)', marginTop: '4px' }}>
              Without a number nobody can confirm this document against the original later, so the
              scan on its own will not get this person into a client&rsquo;s branch.
            </div>
          )}
          {/*
            * Checked here, in the same pass, rather than left for a queue.
            *
            * This is only possible as of the `verifyDocument` fix: the number for a PAN or an
            * Aadhaar lives on the person, and the check used to read the document row, where it is
            * always NULL — so the three documents every bank actually asks for could never be
            * marked verified, and the DOCUMENT_VERIFICATION stage they gate could never be passed.
            * Offered only once there is both a number and a scan, because those two together are
            * what the person pressing it is attesting they compared.
            */}
          {/* `onFile` as well as the box: a number already stored is still a number, and the box
              is deliberately empty while it is covered. */}
          {/*
            * What the card says, asked for only where the card says it.
            *
            * An Aadhaar's address is on the BACK, so the front asks for name, date of birth and
            * gender and nothing else; a PAN prints the father's name where other documents print
            * an address. `prints` comes from the server so the two cannot drift, and asking for a
            * field that is not on the document in front of somebody is how a form teaches people
            * to stop reading it.
            */}
          {doc.prints && scans > 0 && !verified && (
            <PrintedDetails prints={doc.prints} value={printed} onChange={setPrinted} requirement={doc.requirement} />
          )}

          {doc.id && (number.trim() || onFile) && scans > 0 && (
            verified ? (
              <div style={{ fontSize: '12px', color: 'var(--success)', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Check size={13} aria-hidden /> Checked against the original.
                {doc.holderName && <span style={{ color: 'var(--text-muted)' }}>Reads “{doc.holderName}”.</span>}
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                <button
                  type="button"
                  onClick={() => onVerify(doc, printed)}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '6px 12px', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <ShieldCheck size={13} aria-hidden /> I have checked this against the original
                </button>
                {/*
                  * The other half of a review, which did not exist.
                  *
                  * Both screens hard-coded VERIFIED, so a reviewer could only ever agree — a scan
                  * too dark to read had no outcome except being left alone forever, and the person
                  * who sent it was told nothing. The reason picked here is what reaches their phone.
                  */}
                <button
                  type="button"
                  onClick={() => onReject(doc)}
                  className="btn btn-ghost"
                  style={{ fontSize: '12px', padding: '6px 12px', width: 'auto', color: 'var(--danger)' }}
                >
                  Send it back
                </button>
              </div>
            )
          )}

          {doc.verificationStatus === 'REJECTED' && (
            <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>
              {/* `humanize()` rather than the raw value, so an enum this screen does not recognise
                  yet still reads as words — "Number mismatch", never "NUMBER_MISMATCH" — instead
                  of a shouting placeholder the previous fallback would have shown verbatim. */}
              Sent back{doc.rejectionReason ? ` — ${REJECTION_LABELS[doc.rejectionReason] ?? humanize(doc.rejectionReason)}` : ''}.
              Waiting for them to send it again.
            </div>
          )}
        </div>
      )}

      <Scans documentId={doc.id} filePaths={doc.filePaths} label={doc.label} onChanged={onChanged} />
      {rowError && (
        <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '8px' }}>{rowError}</div>
      )}
    </div>
  );
};

const GroupHeading: React.FC<{ icon: React.ReactNode; title: string; note: string; done: number; total: number }> = ({
  icon, title, note, done, total,
}) => (
  <div style={{ marginBottom: '10px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
      <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>{icon}</span>
      <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
      <span style={{ fontSize: '12px', color: done === total ? 'var(--success)' : 'var(--text-muted)' }}>
        {done} of {total} scanned
      </span>
    </div>
    <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{note}</div>
  </div>
);

export const DocumentsStep: React.FC<{
  assayerId: string | null;
  dossier: Dossier | null;
  dossierError: string | null;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}> = ({ assayerId, dossier, dossierError, onChanged, onBusy }) => {
  const { confirm, confirmDialog } = useConfirm();
  const { toast } = useToast();
  const [verifyError, setVerifyError] = useState<string | null>(null);
  /** The document a "Send it back" click is choosing a reason for — open exactly when this is set. */
  const [rejectTarget, setRejectTarget] = useState<DossierDocument | null>(null);
  /** A verify that failed on a name mismatch, waiting on the reviewer's own note before retrying. */
  const [mismatch, setMismatch] = useState<{
    doc: DossierDocument; attested: Record<string, unknown>; message: string;
  } | null>(null);

  const groups = useMemo(() => {
    const rows = dossier?.onboarding ?? [];
    return {
      identity: rows.filter((r) => r.identity),
      joining: rows.filter((r) => !r.identity),
    };
  }, [dossier]);

  /**
   * Attesting that a scan matches the card in the person's hand.
   *
   * Behind a confirmation because it is a statement about what somebody did, not a status they
   * chose: a client's branch relies on it to admit this person to a vault, and a verification
   * nobody actually performed is worse than none at all. One dialog for the whole step rather
   * than one per row — twenty-one hidden dialogs is twenty-one portals for one button's worth of
   * use.
   */
  const verify = async (doc: DossierDocument, printed: PrintedValues) => {
    if (!doc.id) return;
    /**
     * Only the fields this card prints, and only where something was typed.
     *
     * Sending `holderGender: ''` for a PAN card — which does not carry one — would write an empty
     * string over whatever is there and tell the server the reviewer looked at a field that is not
     * on the document.
     */
    const attested = Object.fromEntries(
      Object.entries(printed).filter(([, v]) => String(v ?? '').trim() !== ''),
    );
    const ok = await confirm({
      title: `Confirm ${doc.label} against the original?`,
      message: `This records that you compared ${doc.documentNumber ?? 'the number on file'} and the `
        + `name “${printed.holderName || '—'}” with the document itself, under your name and today’s `
        + 'date.',
      confirmLabel: 'Yes, I checked it',
    });
    if (!ok) return;
    onBusy(true);
    setVerifyError(null);
    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ verdict: 'VERIFIED', ...attested }),
      });
      toast({ type: 'success', title: `${doc.label} checked`, message: 'Recorded against your name.' });
      onChanged();
    } catch (e) {
      /**
       * The server refuses a name that does not agree, and that refusal is the useful part.
       *
       * It comes back naming both names, so it is shown as-is rather than replaced with something
       * generic. If they are genuinely the same person the reviewer answers the follow-up in
       * `NameMismatchModal` and it goes through with their reason recorded beside the grade.
       */
      const message = userMessage(e);
      if (/does not match the name on the record/i.test(message)) {
        setMismatch({ doc, attested, message });
        return;
      }
      setVerifyError(message);
    } finally { onBusy(false); }
  };

  /** The reviewer's answer to `NameMismatchModal` — verify again, this time with their note attached. */
  const submitMismatchOverride = async (note: string) => {
    const target = mismatch;
    setMismatch(null);
    if (!target?.doc.id) return;
    onBusy(true);
    setVerifyError(null);
    try {
      await api.request(`/assayers/document/${target.doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({ verdict: 'VERIFIED', ...target.attested, nameMismatchNote: note }),
      });
      toast({ type: 'success', title: `${target.doc.label} checked`, message: 'Recorded with your note.' });
      onChanged();
    } catch (e) {
      setVerifyError(userMessage(e));
    } finally { onBusy(false); }
  };

  /**
   * Sending a scan back, which nothing in this application could do.
   *
   * Both review screens hard-coded `verdict: 'VERIFIED'`, so a reviewer could only ever agree: a
   * photograph too dark to read had no outcome except being left alone, and the person who sent it
   * was told nothing and waited. The reason chosen here is translated and shown on their phone with
   * an instruction, which is why it is a fixed list rather than a free-text note — `RejectDocumentModal`
   * offers a second, genuinely free note too, but that one stays on the record and is never sent.
   */
  const reject = (doc: DossierDocument) => setRejectTarget(doc);

  /** The reviewer's answer to `RejectDocumentModal`. */
  const submitReject = async (reason: string, note: string) => {
    const doc = rejectTarget;
    setRejectTarget(null);
    if (!doc?.id) return;
    onBusy(true);
    setVerifyError(null);
    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST',
        body: JSON.stringify({
          verdict: 'REJECTED', rejectionReason: reason, ...(note.trim() ? { remarks: note.trim() } : {}),
        }),
      });
      toast({
        type: 'success',
        title: `${doc.label} sent back`,
        message: 'They have been told on their phone, with what to do about it.',
      });
      onChanged();
    } catch (e) {
      setVerifyError(userMessage(e));
    } finally { onBusy(false); }
  };

  if (!assayerId) {
    return (
      <AlertBanner type="error">
        Their record has not been created yet, so there is nowhere to file a scan. Go back to the
        first page and save their name and state.
      </AlertBanner>
    );
  }
  if (dossierError) return <AlertBanner type="error" message={dossierError} />;
  if (!dossier) return <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Reading their file…</div>;

  const scanned = (rows: DossierDocument[]) => rows.filter((r) => r.filePaths.length > 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {confirmDialog}
      {rejectTarget && (
        <RejectDocumentModal
          label={rejectTarget.label}
          onCancel={() => setRejectTarget(null)}
          onSubmit={(reason, note) => void submitReject(reason, note)}
        />
      )}
      {mismatch && (
        <NameMismatchModal
          message={mismatch.message}
          onCancel={() => setMismatch(null)}
          onSubmit={(note) => void submitMismatchOverride(note)}
        />
      )}
      {verifyError && <AlertBanner type="error" message={verifyError} onClose={() => setVerifyError(null)} />}
      <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
        Nothing on this page is required to finish. Scan what the person has brought with them; the
        rest can be added any time from their record, by you or by them if they later get the app.
      </div>

      <div>
        <GroupHeading
          icon={<IdCard size={15} />}
          title="Proof of who they are"
          note="These are what a client's branch asks for before letting somebody near a vault. Type the number off each card as well as scanning it."
          done={scanned(groups.identity)}
          total={groups.identity.length}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groups.identity.map((doc) => (
            <RequirementRow key={doc.requirement} doc={doc} assayerId={assayerId} onChanged={onChanged} onBusy={onBusy} onVerify={(d, printed) => void verify(d, printed)} onReject={reject} />
          ))}
        </div>
      </div>

      <div>
        <GroupHeading
          icon={<FileText size={15} />}
          title="Joining paperwork"
          note="Forms and letters that either arrived or did not. They carry no number and nobody verifies them."
          done={scanned(groups.joining)}
          total={groups.joining.length}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {groups.joining.map((doc) => (
            <RequirementRow key={doc.requirement} doc={doc} assayerId={assayerId} onChanged={onChanged} onBusy={onBusy} onVerify={(d, printed) => void verify(d, printed)} onReject={reject} />
          ))}
        </div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Check size={13} /> Every scan is filed against the person the moment you choose it — there
        is no separate save on this page.
      </div>
    </div>
  );
};
