import type { VisualTemplateData } from './email-template-html';

/**
 * WHO WROTE THIS TEMPLATE, AND WHETHER THE SIMPLE EDITOR MAY REBUILD IT.
 *
 * The simple editor is a form — a headline, a message, a button label — that compiles a whole email
 * from a standard layout. That is exactly right for somebody who is not going to write HTML, and it
 * has one dangerous consequence: compiling REPLACES the entire body.
 *
 * Until this file existed, the form's fields were seeded from hardcoded defaults and never read
 * back out of the stored template, so the sequence below silently destroyed work:
 *
 *   1. A template is customised — in the HTML editor, or shipped as one of the seven files on disk.
 *   2. Somebody opens it and switches to the simple editor to fix one word.
 *   3. The first keystroke recompiles the body from DEFAULTS, and everything written before is gone.
 *   4. Publish. The email that goes to candidates is not the one anybody reviewed.
 *
 * Nothing warned, because nothing knew the difference between "this HTML came from the form" and
 * "a person wrote this". So the form now signs its work: compiled HTML carries a stamp holding the
 * exact field values that produced it. A stamped template can be opened in the form and round-trip
 * safely. An unstamped one is somebody's own HTML, and the form must ASK before replacing it.
 *
 * The stamp is an HTML comment, which every email client ignores and no validator objects to, and
 * it is read back with a plain parse rather than by trusting it: a hand-edited or truncated stamp
 * answers "not mine", which is the safe direction.
 */

/** Opens the stamp. Deliberately unlovely — nobody should mistake it for content. */
const STAMP_OPEN = '<!--fapoms:simple-editor ';
const STAMP_CLOSE = ' -->';
const STAMP_PATTERN = /<!--fapoms:simple-editor ([\s\S]*?) -->/;

/** The form's own fields, written into the HTML it compiled. */
export function stampVisual(html: string, data: VisualTemplateData): string {
  const withoutOld = stripStamp(html);
  // The stamp goes first so that reading it never depends on how long the body is.
  return `${STAMP_OPEN}${JSON.stringify(data)}${STAMP_CLOSE}\n${withoutOld}`;
}

export function stripStamp(html: string): string {
  return (html || '').replace(STAMP_PATTERN, '').replace(/^\s*\n/, '');
}

/**
 * The fields that produced this HTML, or null when the form did not produce it.
 *
 * Null covers every uncertain case — no stamp, damaged JSON, a stamp holding something that is not
 * an object — because the only thing a caller does with null is ask the person before overwriting
 * their work, and asking unnecessarily is a far smaller cost than not asking when it mattered.
 */
export function readVisualStamp(html: string | null | undefined): VisualTemplateData | null {
  if (!html) return null;
  const match = STAMP_PATTERN.exec(html);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    // A stamp with no message in it is not a form's work either — it is a stamp somebody pasted.
    if (typeof parsed.headline !== 'string' && typeof parsed.leadMessage !== 'string') return null;
    return parsed as VisualTemplateData;
  } catch {
    return null;
  }
}

/** Whether the simple editor can safely take this template over without asking. */
export function writtenBySimpleEditor(html: string | null | undefined): boolean {
  return readVisualStamp(html) !== null;
}

export type AuthorshipVerdict = 'empty' | 'simple-editor' | 'hand-written';

/**
 * What the simple editor is about to do to this template.
 *
 * `empty` — nothing to lose, open the form.
 * `simple-editor` — the form wrote it and can restore the exact fields; open it.
 * `hand-written` — somebody else's HTML. ASK, and let "keep it" be the easy answer.
 */
export function authorshipOf(html: string | null | undefined): AuthorshipVerdict {
  const body = stripStamp(html || '').trim();
  if (!body) return 'empty';
  return writtenBySimpleEditor(html) ? 'simple-editor' : 'hand-written';
}
