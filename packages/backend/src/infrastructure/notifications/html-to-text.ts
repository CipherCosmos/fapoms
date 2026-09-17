/**
 * THE OTHER HALF OF EVERY EMAIL, WHICH NOBODY WAS EDITING.
 *
 * Every message this platform sends carries two bodies: the HTML one, and a plain-text one for the
 * clients and settings that refuse HTML. Until now the text half was always regenerated from the
 * built-in renderer, whatever the HTML said — so an administrator could redesign the invitation
 * email, publish it, watch the preview, and a recipient reading in plain text would still get the
 * old wording. Two emails under one subject line, and no screen in the product showed the second.
 *
 * This derives the text from the HTML that is actually being sent, so the two cannot drift.
 *
 * WHAT MATTERS IN THE CONVERSION is not prettiness — it is that the reader can still ACT. A
 * registration invitation whose button becomes the word "Register" with no address behind it is a
 * dead end, so links keep their URL. A one-time code is often inside a styled box; the box goes,
 * the digits stay.
 */

const BLOCK_TAGS = [
  'p', 'div', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'section', 'header', 'footer', 'article', 'blockquote',
];

/** The handful of entities that actually appear in these templates, plus numeric escapes. */
function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/**
 * A readable plain-text rendering of an email's HTML.
 *
 * Deliberately a small, predictable transformation rather than a parser: these templates are
 * table-based marketing-safe HTML with no scripting (the validator forbids it), so tags come off
 * reliably, and a dependency that renders arbitrary documents would be a much larger promise than
 * the job needs.
 */
export function htmlToPlainText(html: string | null | undefined): string {
  if (!html) return '';

  let text = String(html);

  // Anything that is not content at all.
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // A link has to keep its address, or the reader cannot act on the email. "Click here (https://…)"
  // rather than "Click here", and no bare repetition when the label already IS the address.
  text = text.replace(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, label: string) => {
      const words = decodeEntities(label.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const url = href.trim();
      if (!words) return url;
      if (words === url || url.startsWith('mailto:') && url.slice(7) === words) return words;
      return `${words} (${url})`;
    },
  );

  // An image that says nothing is noise; one with alt text is usually the logo or a diagram.
  text = text.replace(/<img\b[^>]*alt\s*=\s*["']([^"']+)["'][^>]*>/gi, (_m, alt: string) => `[${alt}]`);
  text = text.replace(/<img\b[^>]*>/gi, '');

  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(h[1-6]|p|div|tr|table|ul|ol|section|header|footer|article|blockquote)>/gi, '\n\n');
  text = text.replace(new RegExp(`<(${BLOCK_TAGS.join('|')})\\b[^>]*>`, 'gi'), '\n');

  // Everything else is presentation.
  text = text.replace(/<[^>]+>/g, '');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00A0]+/g, ' ').trim())
    // Blank lines are paragraph breaks, and three of them are the same break as one.
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text body to send alongside a rendered HTML email.
 *
 * The built-in wording is kept when the HTML IS the built-in design (nothing has been customised,
 * so the hand-written text is the better of two identical meanings), and when a conversion comes
 * back implausibly short — an HTML body that yields three words is a sign the markup is unusual,
 * and a near-empty text part is worse than a slightly stale one.
 */
export function plainTextFor(
  renderedHtml: string | null | undefined,
  builtInText: string,
  options?: { customised?: boolean },
): string {
  if (options?.customised === false) return builtInText;
  const derived = htmlToPlainText(renderedHtml);
  return derived.length >= 40 ? derived : builtInText;
}
