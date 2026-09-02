import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ScrollText, Play, Square, Copy, ClipboardList, Check, Download, Search, RefreshCw,
  AlertTriangle, Terminal, CircleDot,
} from 'lucide-react';
import { LOG_TAIL_DEFAULT, LOG_TAIL_MAX, type LogLine } from '@fapoms/shared';
import {
  fetchLogServices, fetchLogHistory, streamServiceLogs, renderLogLine, stripAnsi, copyText,
  type AvailableLogService,
} from '../../services/service-logs';
import { userMessage } from '../../services/errors';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import { canAccessRoute } from '../../config/route-permissions';

/**
 * Container logs, in the browser.
 *
 * This exists because the machine is administered by someone else. Every question that ends in
 * "what did the backend actually say when that failed?" otherwise costs a message to a third
 * party and a wait measured in hours, which is long enough that the question usually stops being
 * asked. The platform can answer it directly.
 *
 * Three decisions worth stating, because each looks like an omission otherwise:
 *
 * Searching happens on the server. Filtering the loaded window in the browser would be simpler
 * and would answer the wrong question — the line you are hunting is almost never in the last 500,
 * and a client-side filter would show an empty result with no hint that the match was just
 * outside the window.
 *
 * The buffer is capped while live. A tab left following a chatty service overnight otherwise
 * grows an array until the tab dies, and it dies at the moment the log finally says something.
 *
 * Logs do not survive their container being replaced. A deploy recreates the backend, and its
 * predecessor's output goes with it. The screen says so next to the range control rather than
 * presenting an empty window as though nothing happened.
 */

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '16px',
};

/** Said when both clipboard paths fail, which leaves selecting the text by hand. */
const CLIPBOARD_REFUSED =
  'The browser would not let the page write to the clipboard. Select the text and copy it manually.';

/** Backoff between redials, in ms, then how many consecutive failures before giving up. */
const RECONNECT_DELAYS = [1_000, 2_000, 4_000, 8_000];
const MAX_RECONNECTS = 6;

/** How many lines the live view holds before dropping the oldest. */
const LIVE_BUFFER_MAX = 5_000;

/**
 * Where the screen remembers what you were doing. Wrapped because localStorage throws outright in
 * a few real configurations — Safari private browsing, a browser set to block site data — and a
 * log viewer that cannot render because it could not save a preference is a worse failure than
 * one that forgets which service you picked.
 */
const STORE_SERVICE = 'fapoms_logs_service';
const STORE_FOLLOW = 'fapoms_logs_follow';

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* preference not saved; nothing else breaks */ }
}

const RANGE_PRESETS: { label: string; since?: string }[] = [
  { label: 'Last 15 min', since: '15m' },
  { label: 'Last hour', since: '1h' },
  { label: 'Last 6 hours', since: '6h' },
  { label: 'Last 24 hours', since: '24h' },
  { label: 'Everything kept', since: undefined },
];

export const ServiceLogs: React.FC = () => {
  const roles = useCurrentRoles();
  // Seeded from localStorage so a page refresh resumes what you were watching. Following a log is
  // a stance, not a click: reloading the tab to clear a rendering glitch should not silently stop
  // the thing you reloaded in order to keep watching.
  const [service, setService] = useState<string>(() => readStored(STORE_SERVICE) ?? 'backend');
  const [tail, setTail] = useState<number>(LOG_TAIL_DEFAULT);
  const [since, setSince] = useState<string | undefined>('1h');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [live, setLive] = useState<boolean>(() => readStored(STORE_FOLLOW) === '1');
  const [liveLines, setLiveLines] = useState<LogLine[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'visible' | 'all' | null>(null);
  const [copyingAll, setCopyingAll] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  /** Bumped to make the stream effect re-run and dial again. */
  const [reconnectTick, setReconnectTick] = useState(0);

  const viewport = useRef<HTMLDivElement>(null);
  /**
   * Seed size for a newly opened stream, held in a ref rather than read from state inside the
   * effect below. It is deliberately NOT a dependency: `tail` is a number input, and making the
   * stream restart on it would tear down and re-open the connection on every keystroke.
   */
  const tailRef = useRef(tail);
  tailRef.current = tail;
  /**
   * Which stream run is current. A stream that is torn down still delivers its onClose, and
   * without this the close belonging to the *previous* service would switch following off a
   * moment after the new one started — the exact bug that made changing service stop the follow.
   */
  const streamGen = useRef(0);
  /** Consecutive failed dials, reset by the first line of a healthy stream. */
  const attempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);

  useEffect(() => writeStored(STORE_SERVICE, service), [service]);
  // Cleared here rather than inside the stream effect so that a reconnect keeps what you were
  // already reading instead of blanking the screen every time the backend restarts.
  useEffect(() => { setLiveLines([]); attempts.current = 0; }, [service]);
  useEffect(() => writeStored(STORE_FOLLOW, live ? '1' : '0'), [live]);

  const services = useQuery({
    queryKey: ['log-services'],
    queryFn: ({ signal }) => fetchLogServices(signal),
    staleTime: 30_000,
  });

  const history = useQuery({
    queryKey: ['logs', service, tail, since, appliedSearch],
    queryFn: ({ signal }) => fetchLogHistory(service, { tail, since, q: appliedSearch || undefined }, signal),
    // Disabled while following: the stream is the source of truth then, and a refetch underneath
    // it would replace the tail the user is watching.
    enabled: !live,
  });

  /**
   * The stream's whole lifecycle, in one effect.
   *
   * Previously this was split between a service-change handler that stopped following and a
   * toggle that started it, which meant switching service silently dropped you out of live mode
   * — you changed what you were looking at and it stopped updating, with no indication why.
   * Expressing it as "while `live` and `service` hold these values, a stream should exist" makes
   * a service change re-open the stream against the new service instead of ending it, and makes
   * the cleanup the single place a stream is ever torn down.
   */
  useEffect(() => {
    if (!live) {
      setReconnecting(false);
      return;
    }
    const gen = ++streamGen.current;
    setStreamError(null);
    const stop = streamServiceLogs(service, {
      tail: Math.min(tailRef.current, 1_000),
      onLine: (line) => {
        // A line proves the connection is healthy, so the backoff starts from zero next time.
        attempts.current = 0;
        setReconnecting(false);
        setLiveLines((prev) => {
          const next = prev.length >= LIVE_BUFFER_MAX ? prev.slice(prev.length - LIVE_BUFFER_MAX + 1) : prev.slice();
          next.push(line);
          return next;
        });
      },
      onError: (message, info) => {
        if (gen !== streamGen.current) return;
        setStreamError(message);
        // A rate limit or an auth failure is not something to redial through: exhausting the
        // remaining budget just extends the window in which nothing can connect.
        if (!info.retryable) {
          attempts.current = MAX_RECONNECTS;
          setReconnecting(false);
          setLive(false);
        }
      },
      /**
       * A stream ending is not the same as the user wanting to stop.
       *
       * This stack runs `nest start --watch`, so the API restarts on every code change and takes
       * the stream down with it — and the server closes the stream itself after its own time
       * limit. Treating either as "stop following" meant the follow you switched on was reliably
       * off again minutes later, for reasons that had nothing to do with you. So a close while
       * still following redials, backing off, and only gives up after enough consecutive failures
       * to mean something is actually wrong rather than merely restarting.
       */
      onClose: () => {
        if (gen !== streamGen.current) return;
        if (attempts.current >= MAX_RECONNECTS) {
          setReconnecting(false);
          setStreamError('The live stream keeps dropping. Following has been switched off.');
          setLive(false);
          return;
        }
        const delay = RECONNECT_DELAYS[Math.min(attempts.current, RECONNECT_DELAYS.length - 1)];
        attempts.current += 1;
        setReconnecting(true);
        reconnectTimer.current = window.setTimeout(() => setReconnectTick((t) => t + 1), delay);
      },
    });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the rule assumes a ref holds a DOM
      // node whose identity may have moved on. This one is a generation counter, and advancing it
      // here IS the mechanism: it retires the stream this effect opened so that its late onClose
      // cannot switch following off underneath whichever stream replaced it.
      streamGen.current++;
      if (reconnectTimer.current !== null) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
      stop();
    };
  }, [live, service, reconnectTick]);

  const toggleLive = useCallback(() => setLive((v) => !v), []);

  // Memoised rather than computed inline: `lines` feeds the `text` memo below, and a fresh array
  // identity on every render would rebuild the joined text — which is the whole log — each time
  // any unrelated piece of state changes.
  const lines: LogLine[] = useMemo(
    () => (live ? liveLines : ((history.data?.lines as LogLine[] | undefined) ?? [])),
    [live, liveLines, history.data],
  );
  const text = useMemo(() => lines.map(renderLogLine).join('\n'), [lines]);

  /** Stick to the bottom while following, which is the only time new lines arrive from below. */
  useEffect(() => {
    if (live && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [liveLines, live]);

  const copyVisible = useCallback(async () => {
    if (await copyText(text)) {
      setCopied('visible');
      setTimeout(() => setCopied(null), 1_500);
    } else {
      setStreamError(CLIPBOARD_REFUSED);
    }
  }, [text]);

  /**
   * Copy the whole retained log, not the window on screen.
   *
   * Separate from "Copy visible" because the two answer different questions. Visible is what you
   * are looking at and have already judged relevant. Full is what you send to someone else to
   * look at — and the line that explains the failure is regularly outside the window you happened
   * to load, which is exactly the case where pasting the visible window wastes the round trip.
   *
   * It refetches at the ceiling with no time bound rather than reusing what is loaded, keeping any
   * active search: a filter you typed is intent, a range you left at the default is not.
   */
  const copyFull = useCallback(async () => {
    setCopyingAll(true);
    setStreamError(null);
    try {
      const page = await fetchLogHistory(service, {
        tail: LOG_TAIL_MAX,
        q: appliedSearch || undefined,
      });
      if (await copyText(page.lines.map(renderLogLine).join('\n'))) {
        setCopied('all');
        setTimeout(() => setCopied(null), 1_500);
      } else {
        setStreamError(CLIPBOARD_REFUSED);
      }
    } catch (err) {
      setStreamError(userMessage(err));
    } finally {
      setCopyingAll(false);
    }
  }, [service, appliedSearch]);

  const download = useCallback(() => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${service}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [text, service]);

  if (!canAccessRoute(roles, '/admin/logs')) {
    return (
      <div style={{ ...card, margin: 24 }}>
        <h2 style={{ margin: 0 }}>Service logs</h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          Only administrators can read service logs.
        </p>
      </div>
    );
  }

  const available = services.data ?? [];
  const current = available.find((s) => s.service === service);

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ScrollText size={22} />
        <div>
          <h1 style={{ margin: 0, fontSize: 20 }}>Service logs</h1>
          <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>
            Live and historical output from the containers running this deployment.
            Credentials are stripped before anything leaves the server; every read is recorded in the audit trail.
          </p>
        </div>
      </header>

      {services.isError && (
        <div style={{ ...card, borderColor: 'var(--danger)', display: 'flex', gap: 8 }}>
          <AlertTriangle size={18} />
          <span>{userMessage(services.error)}</span>
        </div>
      )}

      {/* Service picker */}
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {available.length === 0 && !services.isLoading && (
          <span style={{ color: 'var(--text-secondary)' }}>
            No readable services. The Docker log proxy may not be running on this deployment.
          </span>
        )}
        {available.map((s: AvailableLogService) => (
          <button
            key={s.service}
            onClick={() => setService(s.service)}
            title={s.description}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999,
              cursor: 'pointer', fontSize: 13,
              border: `1px solid ${service === s.service ? 'var(--primary)' : 'var(--border-color)'}`,
              background: service === s.service ? 'var(--primary)' : 'transparent',
              color: service === s.service ? '#fff' : 'var(--text-primary)',
            }}
          >
            <CircleDot size={12} style={{ color: s.running ? 'var(--success, #16a34a)' : 'var(--text-secondary)' }} />
            {s.label}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <button
          onClick={toggleLive}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8,
            cursor: 'pointer', border: '1px solid var(--border-color)',
            background: live ? 'var(--danger, #dc2626)' : 'var(--primary)', color: '#fff',
          }}
        >
          {live ? <Square size={14} /> : <Play size={14} />}
          {live ? (reconnecting ? 'Reconnecting…' : 'Stop following') : 'Follow live'}
        </button>

        <select
          value={since ?? ''}
          onChange={(e) => setSince(e.target.value || undefined)}
          disabled={live}
          style={{ padding: '8px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-input, transparent)', color: 'var(--text-primary)' }}
        >
          {RANGE_PRESETS.map((r) => (
            <option key={r.label} value={r.since ?? ''}>{r.label}</option>
          ))}
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          Lines
          <input
            type="number" min={1} max={LOG_TAIL_MAX} value={tail}
            onChange={(e) => setTail(Math.min(Math.max(Number(e.target.value) || 1, 1), LOG_TAIL_MAX))}
            style={{ width: 90, padding: '8px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-input, transparent)', color: 'var(--text-primary)' }}
          />
        </label>

        <form
          onSubmit={(e) => { e.preventDefault(); setAppliedSearch(search); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 220 }}
        >
          <Search size={16} />
          <input
            placeholder="Search the whole range, not just what is on screen"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            disabled={live}
            style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--border-color)', background: 'var(--bg-input, transparent)', color: 'var(--text-primary)' }}
          />
        </form>

        <button onClick={() => history.refetch()} disabled={live} title="Reload"
          style={{ padding: 8, borderRadius: 8, cursor: live ? 'not-allowed' : 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
          <RefreshCw size={16} />
        </button>
        <button onClick={copyVisible} title="Copy the lines currently on screen"
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
          {copied === 'visible' ? <Check size={16} /> : <Copy size={16} />} {copied === 'visible' ? 'Copied' : 'Copy visible'}
        </button>
        <button onClick={copyFull} disabled={copyingAll}
          title={`Fetch and copy the whole retained log for this service${appliedSearch ? ` matching “${appliedSearch}”` : ''}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8, cursor: copyingAll ? 'wait' : 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)', opacity: copyingAll ? 0.6 : 1 }}>
          {copied === 'all' ? <Check size={16} /> : <ClipboardList size={16} />}
          {copyingAll ? 'Fetching…' : copied === 'all' ? 'Copied all' : 'Copy full log'}
        </button>
        <button onClick={download} title="Download as a .log file"
          style={{ padding: 8, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}>
          <Download size={16} />
        </button>
      </div>

      {streamError && (
        <div style={{ ...card, borderColor: 'var(--danger)', display: 'flex', gap: 8 }}>
          <AlertTriangle size={18} /><span>{streamError}</span>
        </div>
      )}

      {/* Notices that explain an empty or short result before it reads as a bug. */}
      {!live && history.data?.truncated && (
        <div style={{ ...card, padding: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
          Showing the most recent {history.data.lines.length} matching lines — older ones exist beyond this window.
          Raise “Lines” or narrow the range to see further back.
        </div>
      )}
      {!live && current && !current.running && (
        <div style={{ ...card, padding: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
          <strong>{current.label}</strong> is not running ({current.state}). You are reading what it left behind.
        </div>
      )}

      {/* The log itself */}
      <div
        ref={viewport}
        style={{
          ...card, flex: 1, minHeight: 280, overflow: 'auto', padding: 12,
          background: 'var(--bg-code, #0b0f19)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      >
        {history.isLoading && !live && <span style={{ color: 'var(--text-secondary)' }}>Loading…</span>}
        {!history.isLoading && lines.length === 0 && (
          <span style={{ color: 'var(--text-secondary)' }}>
            Nothing in this range.
            {history.data?.containerStartedAt && (
              <> This container started {new Date(history.data.containerStartedAt).toLocaleString()}; a deploy replaces the container and its earlier output goes with it.</>
            )}
          </span>
        )}
        {lines.map((line, i) => (
          <div key={i} style={{ color: line.stream === 'stderr' ? 'var(--danger, #f87171)' : 'var(--text-code, #d6deeb)' }}>
            {line.ts && <span style={{ opacity: 0.5 }}>{line.ts.replace('T', ' ').replace(/\.\d+Z$/, '')} </span>}
            {stripAnsi(line.text)}
          </div>
        ))}
      </div>

      <CommandLineHelp service={service} tail={tail} />
    </div>
  );
};

/**
 * The same logs from a terminal.
 *
 * Here because the reason this feature exists is to make logs shareable, and "paste me the last
 * 200 lines of the backend" is a request that wants a command, not a screenshot. The token goes
 * in a header, never the URL — a URL reaches shell history and proxy logs, and this is the most
 * privileged token the system issues.
 */
const CommandLineHelp: React.FC<{ service: string; tail: number }> = ({ service, tail }) => {
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-host';
  const cmd = `curl -sS -H "Authorization: Bearer $FAPOMS_TOKEN" \\
  "${origin}/api/v1/admin/logs/${service}?tail=${tail}&since=1h&format=text"`;

  return (
    <details style={{ ...card, padding: 12 }}>
      <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <Terminal size={16} /> Fetch these logs from a terminal
      </summary>
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        Sign in, then take the token from <code>localStorage.fapoms_token</code> in your browser
        console and export it as <code>FAPOMS_TOKEN</code>. Add <code>&amp;q=search+text</code> to
        filter, or <code>&amp;download=1</code> to save a file. It expires with your session.
      </p>
      <pre style={{ background: 'var(--bg-code, #0b0f19)', padding: 12, borderRadius: 8, overflowX: 'auto', fontSize: 12 }}>
        {cmd}
      </pre>
      <button
        onClick={() => { void copyText(cmd).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }); }}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-primary)' }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy command'}
      </button>
    </details>
  );
};

export default ServiceLogs;
