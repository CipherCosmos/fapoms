/**
 * Retries the one disconnect reason socket.io-client will not retry itself.
 *
 * Extracted out of `socket.ts` so the backoff/gating logic — the part most likely to be subtly
 * wrong and least likely to be caught by eyeballing it — can be driven directly with fake timers,
 * the same reasoning `invalidationCoalescer.ts` documents for the same move. `socket.ts` itself
 * cannot be unit-tested at all in this package's Jest setup: it reads `import.meta.env` at module
 * scope, which is valid only inside a real ES module and fails to even parse under Jest's
 * CommonJS runtime (a pre-existing gap — nothing that touches `import.meta.env` has ever had a
 * spec here). Keeping this file free of that import keeps it testable regardless.
 *
 * ## Why this exists
 *
 * Per socket.io-client's own documented behaviour (`Socket#active`'s doc comment in the library):
 * when the *server* calls `socket.disconnect()`, the client's `disconnect` event reports reason
 * `"io server disconnect"`, and — unlike every other reason (`transport close`, `ping timeout`,
 * ...) — the built-in reconnection manager does not retry it. The socket is marked inactive
 * permanently, until something calls `.connect()` again.
 *
 * The gateway produces exactly this reason whenever a (re)connect's JWT has expired
 * (`EventsGateway#handleConnection`'s `client.emit('error', ...); client.disconnect();`). A
 * 15-minute access token outlives nobody's active clicking, but easily outlives an idle tab's
 * HTTP traffic — a watched dashboard, a desk left open — and this backend restarts often enough
 * under concurrent development traffic to force a reconnect attempt on exactly that stale token.
 * Reproduced live: a tab sitting on the Operations dashboard past its token's lifetime showed
 * "[Socket] Error: Invalid or expired token" then "[Socket] Disconnected: io server disconnect",
 * and the header's live badge stayed red permanently — not just until the next event — even
 * though `fapoms_token` in localStorage was fresh again moments later (any ordinary 401 elsewhere
 * in the app refreshes it; `NotificationDropdown`'s 30s unread-count poll guarantees one inside
 * half a minute). Nothing ever told the socket to look at that fresh token.
 */
export interface ManualReconnect {
  /** Call from the socket's `disconnect` handler with the reason socket.io reported. */
  handleDisconnect(reason: string): void;
  /** Call from the socket's `connect` handler — clears backoff so the next outage starts fresh. */
  handleConnect(): void;
  /** Cancel a pending retry without flushing it — for a real logout. */
  cancel(): void;
}

const RECONNECT_REASON = 'io server disconnect';

export function createManualReconnect(
  /** Whether there is currently a token worth retrying with. */
  hasToken: () => boolean,
  /** Actually attempt the reconnect (e.g. `socket.connect()`). */
  reconnect: () => void,
  initialDelayMs = 1000,
  maxDelayMs = 30000,
): ManualReconnect {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = initialDelayMs;

  return {
    handleDisconnect(reason: string) {
      if (reason !== RECONNECT_REASON || timer) return;
      timer = setTimeout(() => {
        timer = null;
        // Logged out for real (or never logged in) in the meantime — nothing to reconnect
        // with, and retrying would only hit the server with a request that can never succeed.
        if (!hasToken()) return;
        // The retry's own attempt can fail again (token still bad, or genuinely revoked) —
        // each consecutive rejection without an intervening `handleConnect()` widens the wait,
        // mirroring the built-in mechanism's own `reconnectionDelay`/`reconnectionDelayMax`
        // shape so a persistently bad token cannot hammer the server at a flat 1 req/sec.
        delay = Math.min(delay * 2, maxDelayMs);
        reconnect();
      }, delay);
    },

    handleConnect() {
      delay = initialDelayMs;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    cancel() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      delay = initialDelayMs;
    },
  };
}
