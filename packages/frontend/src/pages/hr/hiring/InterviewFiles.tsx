import React, { useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import { scanMimeType } from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { DocumentPreviewModal, type DocumentPreviewItem } from '../../../components/DocumentPreviewModal';
import { ScanOrAttach } from '../../../components/scanner/ScanOrAttach';
import type { InterviewFile } from './pipeline';

/** Upload files to an interview, one at a time, in order. Resolves to how many made it. */
export async function uploadInterviewFiles(interviewId: string, files: File[]): Promise<{ sent: number; error: string | null }> {
  let sent = 0;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file);
    try {
      await api.request(`/assayer-interviews/${interviewId}/file`, { method: 'POST', body: form });
      sent += 1;
    } catch (e) {
      return { sent, error: `"${file.name}" was not kept: ${userMessage(e)}` };
    }
  }
  return { sent, error: null };
}

/**
 * The test papers kept with one interview — viewable, and added to, never removed.
 *
 * They are the grounds for a hiring decision, "did not pass" above all, which is the one a
 * candidate is likely to question. So there is no Remove here, and the screen says so.
 */
export const InterviewFiles: React.FC<{
  interviewId: string;
  files: InterviewFile[];
  /** Given when more may be added; called after an upload so the caller re-reads the interview. */
  onAdded?: () => void;
}> = ({ interviewId, files, onAdded }) => {
  const [preview, setPreview] = useState<{ items: DocumentPreviewItem[]; index: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<DocumentPreviewItem[]>([]);
  useEffect(() => () => { shown.current.forEach((i) => URL.revokeObjectURL(i.url)); }, []);

  const open = async (index: number) => {
    if (busy) return;
    setBusy(true); setError(null);
    const made: string[] = [];
    try {
      const items = await Promise.all(files.map(async (f, i) => {
        const bytes = await api.request<Blob>(`/assayer-interviews/${interviewId}/file/${i}`, { raw: true });
        const type = f.mimeType && f.mimeType !== 'application/octet-stream' ? f.mimeType : (scanMimeType(f.fileName) ?? undefined);
        const url = URL.createObjectURL(type ? new Blob([bytes], { type }) : bytes);
        made.push(url);
        return { title: f.fileName, url, mimeType: type, fileName: f.fileName };
      }));
      shown.current = items;
      setPreview({ items, index });
    } catch (e) {
      made.forEach((u) => URL.revokeObjectURL(u));
      setError(`The file could not be opened. ${userMessage(e)}`);
    } finally { setBusy(false); }
  };

  const close = () => {
    shown.current.forEach((i) => URL.revokeObjectURL(i.url));
    shown.current = [];
    setPreview(null);
  };

  const add = async (picked: File[]) => {
    setBusy(true); setError(null);
    const { error: failed } = await uploadInterviewFiles(interviewId, picked);
    setBusy(false);
    if (failed) setError(failed);
    onAdded?.();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {files.length === 0 ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No test papers kept with this interview.</span>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {files.map((f, i) => (
            <li key={`${f.storageKey}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)' }}>
              <button
                type="button"
                onClick={() => void open(i)}
                disabled={busy}
                aria-label={`View ${f.fileName}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '5px', background: 'none', border: 'none', padding: 0,
                  color: 'var(--accent)', cursor: 'pointer', fontSize: 'var(--text-sm)', textAlign: 'left',
                }}
              >
                <Eye size={13} /> {f.fileName}
              </button>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                {f.uploadedByName ? `by ${f.uploadedByName}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {onAdded && (
        <div>
          <ScanOrAttach
            documentLabel="Interview test paper"
            onFiles={(picked) => void add(picked)}
            multiple
            disabled={busy}
            attachLabel={busy ? 'Uploading…' : 'Add test paper'}
            size="sm"
          />
        </div>
      )}
      {error && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{error}</div>}
      {files.length > 0 && (
        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
          Kept with the interview for good — they cannot be removed.
        </div>
      )}
      <DocumentPreviewModal
        open={preview !== null}
        onClose={close}
        items={preview?.items ?? []}
        initialIndex={preview?.index ?? 0}
      />
    </div>
  );
};

export default InterviewFiles;
