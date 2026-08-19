import { useCallback, useState } from 'react';
import { api } from '../services/api';

/**
 * Downloads the backend `/reports/*` Excel endpoints as a file.
 *
 * The endpoints stream an .xlsx under `Content-Disposition: attachment` and require an
 * auth header, so we fetch through `ApiClient.request({ raw: true })` (which attaches the
 * token) and save the resulting Blob client-side, honouring the server-suggested filename.
 *
 * `busy` exists because these reports are slow — the roster and command-centre sheets build
 * server-side over the whole book — and the browser gives no sign at all that a fetch is in
 * flight (no navigation, no spinner; the file only appears at the end). The export button
 * therefore looked idle for ten or twenty seconds, so people clicked it again, and every
 * extra click fired another full report build. Callers disable their button on `busy` and
 * say so on its face; the flag is a plain boolean because a single caller only ever runs
 * one export at a time, and it is cleared in `finally` so a failed download re-enables the
 * button rather than wedging it.
 */
export function useExcelExport(): {
  download: (endpoint: string, params?: Record<string, string | undefined>) => Promise<void>;
  busy: boolean;
} {
  const [busy, setBusy] = useState(false);

  const download = useCallback(async (endpoint: string, params?: Record<string, string | undefined>) => {
    setBusy(true);
    try {
      await runDownload(endpoint, params);
    } finally {
      setBusy(false);
    }
  }, []);

  return { download, busy };
}

/** The download itself — unchanged behaviour, lifted out so the busy flag wraps it in one place. */
async function runDownload(endpoint: string, params?: Record<string, string | undefined>) {
  const query = Object.entries(params ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  const path = query ? `${endpoint}?${query}` : endpoint;

  const blob = await api.request<Blob>(path, { raw: true });
  const disposition = (blob as any)?.name ?? null;
  let filename = disposition;
  if (/filename\*=UTF-8''/.test(filename || '')) {
    filename = decodeURIComponent(filename!.split("filename*=UTF-8''")[1].split(';')[0]);
  } else if (/filename="?/.test(filename || '')) {
    const m = /filename="?([^";]+)/.exec(filename!);
    if (m) filename = m[1];
  }
  if (!filename || filename === 'blob') filename = `${endpoint.replace(/\//g, '_')}.xlsx`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
