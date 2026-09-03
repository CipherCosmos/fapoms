import React, { useEffect, useMemo, useState } from 'react';
import { Paperclip, Trash2, Check, FileText, IdCard, ShieldCheck } from 'lucide-react';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { AlertBanner, useConfirm, useToast } from '../../../components/ui';
import { looksLikeMask } from '../assayer-shared';
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

const numberInputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 9px', fontSize: '13px', fontFamily: 'monospace',
  background: 'var(--bg-page)', color: 'var(--text-primary)',
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
  const isImage = (key: string) => /\.(jpe?g|png|webp|heic|heif)$/i.test(key);

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
const RequirementRow: React.FC<{
  doc: DossierDocument;
  assayerId: string;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
  onVerify: (doc: DossierDocument) => void;
}> = ({ doc, assayerId, onChanged, onBusy, onVerify }) => {
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
  const [uploading, setUploading] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const { toast } = useToast();

  // The dossier is the truth: a reload after somebody else edited this number, or after the ID
  // step wrote the same column, must show through rather than being hidden by stale local state.
  useEffect(() => { setNumber(boxFor(doc.documentNumber ?? '')); }, [doc.documentNumber]);

  const attach = async (files: FileList) => {
    setUploading(true);
    onBusy(true);
    setRowError(null);
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
      for (const file of Array.from(files)) {
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
        <label
          className="btn btn-secondary"
          style={{ fontSize: '12px', padding: '6px 12px', cursor: uploading ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', width: 'auto' }}
        >
          <Paperclip size={13} />
          {uploading ? 'Adding…' : scans > 0 ? 'Add another page' : 'Add scan or photo'}
          <input
            type="file"
            multiple
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
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
          {doc.id && (number.trim() || onFile) && scans > 0 && (
            verified ? (
              <div style={{ fontSize: '12px', color: 'var(--success)', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Check size={13} aria-hidden /> Checked against the original.
              </div>
            ) : (
              <button
                type="button"
                onClick={() => onVerify(doc)}
                className="btn btn-secondary"
                style={{ marginTop: '8px', fontSize: '12px', padding: '6px 12px', width: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <ShieldCheck size={13} aria-hidden /> I have checked this against the original
              </button>
            )
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
  const verify = async (doc: DossierDocument) => {
    if (!doc.id) return;
    const ok = await confirm({
      title: `Confirm ${doc.label} against the original?`,
      message: `This records that you compared ${doc.documentNumber ?? 'the number on file'} with the `
        + 'document itself, under your name and today’s date.',
      confirmLabel: 'Yes, I checked it',
    });
    if (!ok) return;
    onBusy(true);
    setVerifyError(null);
    try {
      await api.request(`/assayers/document/${doc.id}/verify`, {
        method: 'POST', body: JSON.stringify({ verdict: 'VERIFIED' }),
      });
      toast({ type: 'success', title: `${doc.label} checked`, message: 'Recorded against your name.' });
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
            <RequirementRow key={doc.requirement} doc={doc} assayerId={assayerId} onChanged={onChanged} onBusy={onBusy} onVerify={(d) => void verify(d)} />
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
            <RequirementRow key={doc.requirement} doc={doc} assayerId={assayerId} onChanged={onChanged} onBusy={onBusy} onVerify={(d) => void verify(d)} />
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
