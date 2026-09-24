/**
 * Escape a value for interpolation into an HTML string.
 *
 * Leaflet popups and tooltips given a string set it as `innerHTML`, so every name, city or bank
 * that reaches one came from a record somebody typed — an assayer called
 * `<img src=x onerror=...>` would otherwise run script in every planner's session. Escapes the
 * five characters that matter both in text and inside a quoted attribute. `null`/`undefined`
 * become the empty string, so a missing field renders as nothing rather than as "undefined".
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
