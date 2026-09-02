import { api } from './api';
import type { LogLine, ServiceLogsPage, LogServiceDescriptor } from '@fapoms/shared';

export interface AvailableLogService extends LogServiceDescriptor {
  running: boolean;
  state: string;
  containerName: string;
}

export interface LogHistoryQuery {
  tail?: number;
  since?: string;
  until?: string;
  q?: string;
}

export async function fetchLogServices(signal?: AbortSignal): Promise<AvailableLogService[]> {
  const data = await api.request<{ services: AvailableLogService[] }>('/admin/logs/services', { signal });
  return data.services;
}

export async function fetchLogHistory(
  service: string,
  query: LogHistoryQuery = {},
  signal?: AbortSignal,
): Promise<ServiceLogsPage> {
  const params = new URLSearchParams();
  if (query.tail) params.set('tail', String(query.tail));
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.q) params.set('q', query.q);
  const qs = params.toString();
  return api.request<ServiceLogsPage>(`/admin/logs/${encodeURIComponent(service)}${qs ? `?${qs}` : ''}`, {
    // A log query walks the container's whole journal server-side; the default 30s is not enough
    // for a wide `since` on a service that talks a lot.
    timeoutMs: 120_000,
    signal,
  });
}

/**
 * Follow a service live.
 *
 * Implemented over `fetch` rather than `EventSource`, which would have been the obvious choice
 * and is unusable here: EventSource cannot set request headers, so the only way to authenticate
 * it is to put the access token in the query string. URLs reach shell history, proxy access logs
 * and the browser's address bar — a token that lands in any of those has been published, and this
 * is a screen whose entire audience is administrators holding the most privileged token there is.
 * So the stream is read as a byte stream and the SSE frames are parsed here, which costs about
 * twenty lines and keeps the credential in a header.
 *
 * @returns a function that stops the stream.
 */
export function streamServiceLogs(
  service: string,
  opts: {
    tail?: number;
    onLine: (line: LogLine) => void;
    /** `retryable` is false when redialling cannot help — rate limits and auth failures. */
    onError: (message: string, info: { retryable: boolean }) => void;
    onClose: () => void;
  },
): () => void {
  const controller = new AbortController();
  const token = localStorage.getItem('fapoms_token');
  const params = new URLSearchParams();
  if (opts.tail) params.set('tail', String(opts.tail));

  void (async () => {
    try {
      const res = await fetch(
        `/api/v1/admin/logs/${encodeURIComponent(service)}/stream?${params}`,
        {
          headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );
      if (!res.ok || !res.body) {
        // Whether to redial is decided here, from the status, rather than by the caller guessing.
        // A 429 is the case that matters: the stream endpoint is rate limited, and a reconnect
        // loop that retries through it spends the whole next window making the limit worse and
        // never recovers. Auth failures are equally pointless to repeat.
        if (res.status === 429) {
          opts.onError(
            'Too many live-stream requests. Wait a minute, then start following again.',
            { retryable: false },
          );
        } else if (res.status === 401 || res.status === 403) {
          opts.onError(
            'Your session is no longer allowed to read logs. Sign in again.',
            { retryable: false },
          );
        } else if (res.status === 503) {
          opts.onError(
            'The log service is unavailable — the Docker log proxy may not be running.',
            { retryable: true },
          );
        } else {
          opts.onError(`Could not open the live stream (HTTP ${res.status}).`, { retryable: true });
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // SSE frames are separated by a blank line, and a frame can straddle two reads.
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          // ': keep-alive' comment frames carry no data and exist only to hold the connection.
          if (frame.startsWith(':')) continue;
          const isError = frame.includes('event: error');
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(6));
            if (isError) opts.onError(payload.message ?? 'The log stream failed.', { retryable: true });
            else opts.onLine(payload as LogLine);
          } catch {
            // A truncated frame is not worth tearing the stream down for.
          }
        }
      }
    } catch (err) {
      // An abort is the caller stopping us on purpose, not a failure to report.
      if ((err as Error).name !== 'AbortError') {
        opts.onError((err as Error).message || 'The log stream ended unexpectedly.', { retryable: true });
      }
    } finally {
      opts.onClose();
    }
  })();

  return () => controller.abort();
}

/**
 * Remove ANSI colour and cursor escapes.
 *
 * Nest, Vite and Postgres all colour their output. A terminal renders those bytes as colour; a
 * browser renders them as a literal `[32m` scattered through every line, which is what the first
 * working build of this screen showed and it made the log close to unreadable. Stripped for
 * display and for copying alike, because a log pasted into a chat window has the same problem.
 *
 * Deliberately NOT stripped by the API: `format=text` is read by a terminal, where the colour is
 * worth keeping. The choice belongs to the reader, so it is made at the point of rendering.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}


/**
 * Copy text, including where the Clipboard API is unavailable.
 *
 * `navigator.clipboard` is gated on a secure context, and this deployment is served over plain
 * HTTP on an IP address — so on the box this feature was built for, the modern API is simply
 * absent and every copy button would fail. Which is close to the whole point of the screen: the
 * logs exist to be pasted somewhere else.
 *
 * So the modern path is tried first and the old `execCommand('copy')` is kept as the fallback.
 * It is deprecated, works in a non-secure context, and is the only thing that does.
 *
 * @returns whether the text reached the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or the API is present but blocked; fall through to the fallback.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Off-screen but not display:none — a hidden element cannot be selected, and an element that
    // scrolls the page into view is worse than the problem being solved.
    area.style.position = 'fixed';
    area.style.top = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** One line as text, matching the API's `format=text`, minus the colour escapes. */
export function renderLogLine(line: LogLine): string {
  return `${line.ts ? `${line.ts} ` : ''}${line.stream === 'stderr' ? '[stderr] ' : ''}${stripAnsi(line.text)}`;
}
