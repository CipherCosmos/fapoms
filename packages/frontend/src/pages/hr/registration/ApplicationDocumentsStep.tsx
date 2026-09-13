import React, { useEffect, useState } from 'react';
import { Paperclip, Upload } from 'lucide-react';
import {
  ONBOARDING_DOCUMENT_LABELS, SCAN_UPLOAD_ACCEPT, SCAN_UPLOAD_MIME_TYPES, DEFAULT_MAX_UPLOAD_MB,
  type OnboardingDocument,
} from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { AlertBanner, useToast } from '../../../components/ui';

/**
 * The papers the candidate brought, scanned onto their APPLICATION.
 *
 * Deliberately much smaller than `DocumentsStep`, which this replaces on the registration path and
 * which stays exactly where it is for the roster's own paperwork tab. That one does document
 * numbers, verification verdicts and holder-name matching against the card; an application document
 * is `{applicationId, requirement, filePaths}` and nothing else, by design — see the entity's own
 * comment. Rendering a verify button over a row that cannot hold a verdict would be four controls
 * that look like they work.
 *
 * So: what is asked for, what has arrived, and a way to add and look at a scan. Verification is a
 * post-approval act on the record, where there is somewhere to record it.
 *
 * The requirement list is the server's (`documentsRequested`), which depends on whether the
 * candidate is a freelancer or a proprietor — the spec's two document sets. It is not rebuilt
 * here, so the desk is asked for exactly what the candidate's own form asks for.
 */

/** "PDF or an image (JPEG/PNG/WebP/HEIC/TIFF/BMP/GIF)" — the same words `assertUploadAllowed`
 * refuses with on the server, so a clerk never learns two different names for what this box takes. */
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

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)',
  padding: '12px 14px',
};

/**
 * The scans on one requirement, as thumbnails you can open.
 *
 * The route needs an Authorization header, so a plain `<img src>` cannot fetch it — the bytes come
 * through `api.request` as a blob and become an object URL, the way every other protected file in
 * this app is read. Revoked on unmount, or the tab leaks a copy of every identity document
 * somebody scrolls past.
 */
const Scans: React.FC<{
  applicationId: string;
  requirement: string;
  filePaths: string[];
}> = ({ applicationId, requirement, filePaths }) => {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const fingerprint = filePaths.join('|');

  useEffect(() => {
    if (filePaths.length === 0) { setUrls([]); return undefined; }
    let live = true;
    const made: string[] = [];
    Promise.all(filePaths.map((_, i) =>
      api.request<Blob>(`/hr/applications/${applicationId}/documents/${requirement}/file/${i}`, { raw: true })
        .then((b) => { const u = URL.createObjectURL(b); made.push(u); return u; })
        .catch(() => null),
    )).then((list) => { if (live) setUrls(list); }).catch(() => { if (live) setUrls([]); });
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
    // `fingerprint` rather than the array: a new array identity on every reload would re-fetch and
    // re-allocate every thumbnail on the page for no change at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationId, requirement, fingerprint]);

  if (filePaths.length === 0) return null;
  // TIFF is deliberately not here: browsers cannot render it, so a TIFF page stays a link rather
  // than a broken thumbnail.
  const isImage = (key: string) => /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(key);

  return (
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
      {filePaths.map((key, i) => {
        const url = urls[i];
        const name = key.split('/').pop() ?? 'file';
        return (
          <a
            key={key}
            href={url ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title={name}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none',
              color: 'var(--accent-primary)', fontSize: 'var(--text-xs)',
            }}
          >
            {url && isImage(key) ? (
              <img
                src={url}
                alt={name}
                style={{
                  width: 46, height: 46, objectFit: 'cover',
                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)',
                }}
              />
            ) : (
              <><Paperclip size={12} /> Page {i + 1}</>
            )}
          </a>
        );
      })}
    </div>
  );
};

const Requirement: React.FC<{
  applicationId: string;
  requirement: string;
  filePaths: string[];
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}> = ({ applicationId, requirement, filePaths, onChanged, onBusy }) => {
  const [uploading, setUploading] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { toast } = useToast();
  const label = ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const chosen = Array.from(files);
    for (const file of chosen) {
      const problem = scanUploadProblem(file);
      if (problem) { setRefusal(`${file.name} ${problem}`); return; }
    }
    setRefusal(null);
    setUploading(true);
    onBusy(true);
    try {
      // One request per file rather than one multi-file request, because the commonest requirement
      // in the list is a card with two sides and the route takes one scan at a time. Sequential,
      // so a failure names the page it failed on rather than leaving a partial set unexplained.
      for (const file of chosen) {
        const body = new FormData();
        body.append('file', file);
        await api.request(`/hr/applications/${applicationId}/documents/${requirement}`, {
          method: 'POST', body, raw: true,
        });
      }
      onChanged();
    } catch (e) {
      toast({ type: 'error', message: userMessage(e) });
    } finally {
      setUploading(false);
      onBusy(false);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', flex: 1, minWidth: 0 }}>{label}</span>
        <span style={{
          fontSize: 'var(--text-2xs)',
          color: filePaths.length > 0 ? 'var(--success)' : 'var(--text-muted)',
        }}
        >
          {filePaths.length > 0
            ? `${filePaths.length} ${filePaths.length === 1 ? 'page' : 'pages'} on file`
            : 'Not yet attached'}
        </span>
        <label
          className="btn btn-secondary btn-sm"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', margin: 0 }}
        >
          <Upload size={13} />
          {uploading ? 'Uploading…' : filePaths.length > 0 ? 'Add a page' : 'Attach'}
          <input
            type="file"
            multiple
            accept={SCAN_UPLOAD_ACCEPT}
            // Phone browsers offer the camera directly alongside the gallery when a capture hint
            // is present, which is how a scan gets taken at the desk with the card in hand.
            capture="environment"
            disabled={uploading}
            onChange={(e) => { void upload(e.target.files); e.target.value = ''; }}
            style={{ display: 'none' }}
          />
        </label>
      </div>
      {refusal && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: '6px' }}>{refusal}</div>
      )}
      <Scans applicationId={applicationId} requirement={requirement} filePaths={filePaths} />
    </div>
  );
};

export const ApplicationDocumentsStep: React.FC<{
  applicationId: string;
  /** What this candidate is asked for, given the category they chose. The server's list. */
  requested: string[];
  documents: Array<{ requirement: string; filePaths: string[] }>;
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}> = ({ applicationId, requested, documents, onChanged, onBusy }) => {
  const filesFor = (requirement: string) =>
    documents.find((d) => d.requirement === requirement)?.filePaths ?? [];

  if (requested.length === 0) {
    return (
      <div style={{ ...cardStyle, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
        Choose whether they are a freelancer or a proprietor on the first step — that decides which
        documents they are asked for.
      </div>
    );
  }

  const outstanding = requested.filter((r) => filesFor(r).length === 0).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {/*
        Said plainly rather than as a blocker. Only the photograph is refused at approval — it is
        what the ID card prints, and a field identity card with no face on it is not one — and the
        rest travel with the person as gaps to chase. A step that refused to advance would stop a
        candidate being registered at all because their electricity bill is at home.
      */}
      {outstanding === 0 ? (
        <AlertBanner type="success">
          Every document this candidate is asked for is on file.
        </AlertBanner>
      ) : (
        <div style={{ ...cardStyle, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
          {outstanding} of {requested.length} still to come. They can attach the rest through their
          own link — nothing here blocks the registration except the photograph, which approval
          refuses without.
        </div>
      )}

      {requested.map((requirement) => (
        <Requirement
          key={requirement}
          applicationId={applicationId}
          requirement={requirement}
          filePaths={filesFor(requirement)}
          onChanged={onChanged}
          onBusy={onBusy}
        />
      ))}

      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
        Up to {DEFAULT_MAX_UPLOAD_MB}MB a page. Checking a document against the original happens on
        their record after they are approved, where the verdict has somewhere to live.
      </div>
    </div>
  );
};

export default ApplicationDocumentsStep;
