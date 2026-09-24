import { isIP } from 'net';
import { promises as dns } from 'dns';

/**
 * Save-time checks for the settings that point the server at a network address.
 *
 * Two settings are addresses an operator types: `app.publicUrl`, which every emailed link and
 * set-password link is built from, and `email.smtpHost`, which the API opens a TCP connection to.
 * A public URL on plain http or on an internal host sends people's one-time links in the clear or
 * to nowhere; an SMTP host on a private or loopback address turns the settings screen into a way
 * to make the server connect to its own internal services (Redis, Postgres, the cloud metadata
 * endpoint). Both are refused in production. Outside production local addresses are the normal
 * case (the dev stack runs on localhost), so only the shape is checked there.
 *
 * Only the save path runs these. The environment variable remains the operator's own, unchecked
 * fallback, exactly as before.
 */

const isProduction = () => process.env.NODE_ENV === 'production';

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, also the tailnet range
    a >= 224 // multicast and reserved
  );
}

/** True for loopback, private, link-local, unique-local, CGNAT and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) {
    const v6 = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return ipv4Private(mapped[1]);
    return (
      v6 === '::' || v6 === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(v6) || // fc00::/7 unique local
      /^fe[89ab][0-9a-f]:/.test(v6) // fe80::/10 link local
    );
  }
  return false;
}

/**
 * True for a host that can only mean "inside this network": a private IP literal, `localhost`
 * and its subdomains, `.local`/`.internal`/`.localdomain` names, and single-label names such as
 * a container's service name (`redis`, `postgres`).
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return true;
  if (isIP(h)) return isPrivateAddress(h);
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (/\.(local|internal|localdomain|lan|home\.arpa)$/.test(h)) return true;
  return !h.includes('.');
}

/** Returns a message when the value is refused, `null` when it may be saved. */
export function validatePublicUrl(value: unknown): string | null {
  if (value == null || value === '') return null;
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    return 'Application address must be a full address such as https://fapoms.example.com.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Application address must start with https://.';
  }
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return 'Application address must be only the site address (for example https://fapoms.example.com), with no path, query or login in it.';
  }
  if (isProduction()) {
    if (url.protocol !== 'https:') {
      return 'Application address must start with https:// — every emailed sign-in and set-password link is built from it.';
    }
    if (isInternalHost(url.hostname)) {
      return 'Application address must be a public address that staff can reach, not a local or private one.';
    }
  }
  return null;
}

export async function validateSmtpHost(value: unknown): Promise<string | null> {
  if (value == null || value === '') return null;
  const host = String(value).trim();
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) {
    return 'SMTP host must be a server name such as smtp.yourprovider.com, with no scheme, port or path.';
  }
  if (!isProduction()) return null;
  if (isInternalHost(host)) {
    return 'SMTP host must be your mail provider\'s public server name, not a local or private address.';
  }
  // A public-looking name that resolves inward is the same thing with one more step. A lookup
  // that fails is not a refusal: the name may simply not resolve from here yet, and sending
  // will fail loudly on its own.
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      return 'SMTP host resolves to a local or private address, which the platform will not connect to.';
    }
  } catch {
    /* unresolvable now — allowed, see above */
  }
  return null;
}
