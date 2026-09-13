/**
 * The backend hands out a RELATIVE signaling path (`/livekit`) — a client connects to the same
 * origin it already talks REST to, and the backend pipes the WebSocket to the SFU internally, so
 * neither the browser nor the phone ever contacts LiveKit directly. An absolute URL (a deployment
 * fronting the SFU with its own TLS name) passes through unchanged.
 *
 * `apiOrigin` is supplied by the caller rather than resolved in here, because where "this
 * client's own origin" comes from is platform-specific: `window.location.origin` on the web, an
 * emulator/LAN-aware resolver (`MobileApiService.getApiOrigin()`) on a phone. This function only
 * knows how to combine the two once each side has its own answer.
 *
 * `rewriteLocalhost` defaults to off. It exists for React Native only: a physical device's own
 * "localhost" is never the API host (the 10.0.2.2 emulator rule, or an operator-configured LAN
 * address, already stand between a phone and the server), so a legacy absolute `ws://localhost:*`
 * URL is rewritten onto the resolved API host rather than passed through — the same host
 * `apiOrigin` already resolves to. A browser tab's own origin already IS the host its
 * `window.location` means, so the same rewrite would be a no-op there at best and a surprising
 * new behaviour at worst; the flag keeps this function's default identical to the web's original,
 * simpler three-line form.
 */
export function resolveLiveKitUrl(
  rawUrl: string,
  apiOrigin: string,
  opts: { rewriteLocalhost?: boolean } = {},
): string {
  if (rawUrl.startsWith('/')) return `${apiOrigin}${rawUrl}`;
  if (!opts.rewriteLocalhost) return rawUrl;

  // Regex rather than `new URL`: Hermes' URL implementation on React Native is incomplete, and
  // this must never be the thing that breaks a call. Preserves scheme, port and path.
  const localhost = /^(\w+:\/\/)(localhost|127\.0\.0\.1)(?=[:/]|$)/i;
  if (!localhost.test(rawUrl)) return rawUrl;
  const apiHost = apiOrigin.match(/^\w+:\/\/([^/:]+)/)?.[1];
  if (!apiHost) return rawUrl;
  return rawUrl.replace(localhost, (_m, scheme: string) => `${scheme}${apiHost}`);
}
