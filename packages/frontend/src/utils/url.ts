/**
 * Only let a stored URL become a clickable link if it is plainly http(s).
 *
 * A client's `website`, and other user-entered URLs, are rendered into `<a href>`. A value like
 * `javascript:fetch('/api/...').then(...)` in that field runs in the app's own origin the moment
 * someone clicks it — a stored-XSS foothold with only client-edit permission. Anything that is
 * not an `http:` or `https:` URL (javascript:, data:, vbscript:, file:, a bare word) returns
 * null, and the caller then shows the text without making it a link.
 */
export function safeHttpUrl(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    // Resolve relative to a base so a scheme-relative or path value parses, then insist on http(s).
    const u = new URL(raw, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
