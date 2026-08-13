import { useCallback } from 'react';
import { api } from '../services/api';

/**
 * Downloads the backend `/reports/*` Excel endpoints as a file.
 *
 * The endpoints stream an .xlsx under `Content-Disposition: attachment` and require an
 * auth header, so we fetch through `ApiClient.request({ raw: true })` (which attaches the
 * token) and save the resulting Blob client-side, honouring the server-suggested filename.
 */
export function useExcelExport(): {
  download: (endpoint: string, params?: Record<string, string | undefined>) => Promise<void>;
} {
  const download = useCallback(async (endpoint: string, params?: Record<string, string | undefined>) => {
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
  }, []);

  return { download };
}