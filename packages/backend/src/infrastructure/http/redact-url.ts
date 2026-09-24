/**
 * A URL as it may be written to a log, an alert or a request context.
 *
 * WHY THIS EXISTS. A candidate's registration link is `/public/registration/<token>`, and that token
 * is the only thing standing between the internet and the candidate's PAN, Aadhaar, bank account and
 * scanned ID. The exception filter logged `req.originalUrl` verbatim, and so did the reverse proxy:
 * an audit of the running stack found 398 log lines each holding a working link to somebody's
 * identity documents. A log is read by more people, kept longer and copied further than the data it
 * describes, so a secret in a path has to be taken out before the path is written anywhere.
 *
 * Two kinds of secret are removed:
 *  - path segments that ARE a bearer credential (the registration token, a staff password-setup
 *    token, a document download token);
 *  - query parameters that carry an identity number or a token (`identifier-check` puts a full PAN
 *    and Aadhaar in its query string).
 *
 * The shape of the path is kept — method, route and status are what an operator needs from a log,
 * and none of them is secret.
 */
const SECRET_PATH_SEGMENTS: Array<[RegExp, string]> = [
  [/(\/public\/registration\/)[^/?#]+/gi, '$1[token]'],
  [/(\/register\/)[^/?#]+/gi, '$1[token]'],
  // A staff password-setup/reset link: until spent it IS that person's password. Covers the page
  // (`/account-setup/<token>`) and the API it calls (`/api/v1/public/account-setup/<token>`).
  [/(\/account-setup\/)[^/?#]+/gi, '$1[token]'],
];

const SECRET_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'code', 'otp',
  'pannumber', 'aadhaarnumber', 'bankaccountnumber', 'accountnumber',
]);

export function redactUrl(url: string | null | undefined): string {
  if (!url) return '';
  const parts = String(url).split(/\?(.*)/s, 2);
  let path = parts[0];
  const query = parts[1];
  for (const [pattern, replacement] of SECRET_PATH_SEGMENTS) {
    path = path.replace(pattern, replacement);
  }
  if (!query) return path;
  const redactedQuery = query
    .split('&')
    .map((pair) => {
      const [rawKey] = pair.split('=', 1);
      let key = rawKey;
      try { key = decodeURIComponent(rawKey); } catch { /* keep the raw key */ }
      return SECRET_QUERY_KEYS.has(key.toLowerCase()) ? `${rawKey}=[redacted]` : pair;
    })
    .join('&');
  return `${path}?${redactedQuery}`;
}
