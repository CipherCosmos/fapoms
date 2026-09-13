/**
 * Reconnection behaviour for both live clients' Socket.IO connection.
 *
 * Both used to give up: ten attempts with a five-second ceiling, so a closed laptop lid, a
 * Wi-Fi switch, a brief VPN drop, or an assayer spending twenty minutes in a bank vault with no
 * signal was enough to kill the socket for good after about a minute. It stayed dead for the
 * rest of the session — an operations desk quietly stopped receiving live updates with nothing
 * on screen saying so, and a phone coming back into signal never reconnected on its own. Both
 * were fixed the same way: never give up, and back the delay off to a 30-second ceiling so a
 * long outage across a whole roster does not turn into every handset retrying in lockstep
 * against the same server the moment it comes back.
 *
 * Kept as one object, once both sides already agreed, so a future change to one cannot silently
 * leave the other back on the old ten-attempt behaviour.
 *
 * Deliberately NOT here: `auth` (each client reads its own token from its own storage), the
 * connection URL, and the manual-reconnect path a server-initiated disconnect needs (socket.io
 * does not retry a close the server itself chose to send, e.g. an expired JWT) — the web client
 * has one, built around this same `reconnectionDelay`/`reconnectionDelayMax` shape; the mobile
 * client's own retry-on-error path is not the same code. Real per-platform differences, not
 * something this object should absorb.
 */
export const SOCKET_RECONNECT_CONFIG = {
  // Not `as const`: socket.io-client's own `ManagerOptions.transports` type is a mutable
  // `string[]`, and a `readonly` tuple here does not satisfy it at either call site.
  transports: ['websocket', 'polling'] as string[],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 30000,
  randomizationFactor: 0.5,
};
