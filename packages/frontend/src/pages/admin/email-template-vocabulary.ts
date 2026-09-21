/**
 * What the email-template screen calls things, in words an operator already owns.
 *
 * This screen is used by whoever looks after the company's outgoing email — not necessarily
 * anybody who has seen the repository. It was asking them to choose between:
 *
 *     Source Preference:  [ Platform Override (Custom) ]
 *                         [ Filesystem Disk Template (Factory Default) ]
 *                         [ Built-in Fallback ]
 *
 * Three words for three storage locations, none of which mean anything outside the code. The
 * question actually being asked is much smaller: **which version of this email should we send?**
 * There are only ever three answers — the one you edited here, the one the product shipped with,
 * or the plain one the code can always produce.
 *
 * Nothing about the behaviour changes. `platform`, `filesystem` and `fallback` are still exactly
 * what goes to the API; only the words on screen are the operator's rather than the engine's.
 *
 * The same pass removed three claims that were not information:
 *   "Factory Default Active (100% Guaranteed Stable)"  — a percentage nobody measured
 *   "Viewing Certified Factory Baseline"               — certified by whom
 *   "Zero-Downtime Guarantee ... fallback cascade"     — true underneath, unreadable on top
 * The last one describes a real and reassuring safety net, so it is still said — as the one
 * sentence it actually is.
 */

/** The three places an email's design can come from. The values are the API's, unchanged. */
export type TemplateSource = 'platform' | 'filesystem' | 'fallback';

export interface SourceWords {
  /** The badge on the template list. Short enough for a chip. */
  badge: string;
  /** The option in the "send which version" menu. */
  option: string;
  /** One line of hover help — what this version actually is. */
  hint: string;
}

export const TEMPLATE_SOURCE: Record<TemplateSource, SourceWords> = {
  platform: {
    badge: 'Yours',
    option: 'Your edited version',
    hint: 'The version written and published on this screen. This is what goes out.',
  },
  filesystem: {
    badge: 'Original design',
    option: 'The original design',
    hint: 'The email as it was designed and shipped with the product, before anybody edited it.',
  },
  fallback: {
    badge: 'Plain built-in',
    option: 'The plain built-in version',
    hint: 'A plain version the system can always produce. Correct and readable, but undesigned — '
        + 'used only when neither of the other two can be.',
  },
};

/**
 * The badge, with the version number when there is one.
 *
 * Only `platform` has versions — the other two are whatever the installed product contains — so
 * the number is appended rather than built into the word.
 */
export const sourceBadge = (source: TemplateSource, version?: number | null): string =>
  source === 'platform' && version != null
    ? `${TEMPLATE_SOURCE.platform.badge} · v${version}`
    : TEMPLATE_SOURCE[source]?.badge ?? source;

export const sourceOption = (source: TemplateSource): string =>
  TEMPLATE_SOURCE[source]?.option ?? source;

export const sourceHint = (source: TemplateSource): string =>
  TEMPLATE_SOURCE[source]?.hint ?? '';

/** Menu order: the one you most likely want first. */
export const TEMPLATE_SOURCE_ORDER: readonly TemplateSource[] = ['platform', 'filesystem', 'fallback'];

/**
 * How the email currently being sent was written.
 *
 * "Source Mode: Visual No-Code Form (Auto-Compiled)" described the implementation — that the form
 * compiles to HTML — where the reader only needs to know which of the two editors made this.
 */
export const EDITOR_USED = {
  visual: 'the form',
  code: 'the HTML editor',
} as const;

/**
 * Restoring the shipped design. "Factory Default" reads like a hardware reset; on this screen it
 * is a much smaller and more reversible thing, and saying so is what stops it being frightening.
 */
export const RESTORE_ORIGINAL = {
  action: 'Restore the original design',
  hint: 'Puts the shipped design back on live email. Your edited version is kept and can be '
      + 'published again at any time.',
} as const;

/**
 * The safety net, as one sentence.
 *
 * The behaviour is real — `email-template-loader.ts` validates each tier before use and falls
 * through to the next — and it is worth telling an operator who is nervous about pressing
 * Publish. It just does not need the words "cascade", "runtime error" or "guarantee".
 */
export const PUBLISH_SAFETY_NET =
  'If your version ever fails to render, the original design is sent instead — no email is lost.';

/**
 * The three checks shown before Publish, named for what they prove rather than how they work.
 *
 * They were "Token Contract Completeness", "Token Scope Whitelist" and "Live Payload Simulation
 * Test" — accurate about the implementation and silent about the consequence. The person reading
 * them is about to send this to real candidates and wants to know one thing per row: is anything
 * going to arrive wrong?
 */
export const PUBLISH_CHECKS = {
  required: {
    title: 'Every required placeholder is there',
    ok: (n: number) => `All ${n} are in your wording`,
    /** Naming them matters — the reader has to go and put them back. */
    bad: (missing: string[]) => `Missing: ${missing.join(', ')} — these arrive blank`,
  },
  unknown: {
    title: 'No unknown placeholders',
    ok: 'Nothing in your wording will arrive empty',
    bad: (n: number) =>
      `${n} placeholder${n === 1 ? '' : 's'} nobody fills in — ${n === 1 ? 'it' : 'they'} will arrive blank`,
  },
  renders: {
    title: 'It builds correctly with sample values',
    ok: 'Filled in with sample values without an error',
  },
} as const;

/** What the preview is showing, said plainly. */
export const PREVIEW_NOTE = 'Preview, filled in with sample values';

/**
 * Gmail stops rendering a message past roughly 102 KB and shows "Message clipped" with a link.
 *
 * Everything after the cut is invisible unless the reader clicks — which, on an email carrying a
 * verification code or a one-time link, means the reader never sees the thing the email exists
 * to deliver.
 */
export const GMAIL_CLIP_BYTES = 102 * 1024;

const byteLength = (s: string): number => {
  // TextEncoder is present in every browser this ships to; the fallback keeps the summary
  // rendering in any test environment that lacks it rather than blanking the row.
  try { return new TextEncoder().encode(s).length; } catch { return s.length; }
};

/**
 * How big this email is, and whether that matters — replacing "Content Size: 12043 characters".
 *
 * A character count is not a fact anybody can act on: nobody knows what number is too big, so the
 * row was read past. The number that matters is Gmail's, so the row now states the size against
 * it and says what happens if it is crossed.
 */
export function contentSizeNote(html: string): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  const bytes = byteLength(html);
  const kb = bytes / 1024;
  const shown = kb < 10 ? kb.toFixed(1) : String(Math.round(kb));

  if (bytes >= GMAIL_CLIP_BYTES) {
    return {
      tone: 'bad',
      text: `${shown} KB — over Gmail's 102 KB limit. Gmail will cut this off and show `
          + `"Message clipped", so anything near the end may never be seen.`,
    };
  }
  if (bytes >= GMAIL_CLIP_BYTES * 0.8) {
    return {
      tone: 'warn',
      text: `${shown} KB — close to Gmail's 102 KB limit, past which it shows "Message clipped".`,
    };
  }
  return { tone: 'ok', text: `${shown} KB — comfortably under Gmail's 102 KB limit.` };
}
