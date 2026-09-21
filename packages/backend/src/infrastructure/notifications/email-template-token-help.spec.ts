import { EMAIL_TEMPLATE_TOKEN_HELP, COMMON_MESSAGE_TOKENS, emailTokenHelp } from '@fapoms/shared';
import { EMAIL_TEMPLATE_REGISTRY } from './email-template-registry';

/**
 * Every placeholder an editor can insert has to say what it becomes.
 *
 * The email editor lists each template's placeholders as chips you click to insert. Their entire
 * hover text used to be the chip's own name restated — "Required token {{otpCode}} is present" —
 * so somebody rewriting the wording of an email could see WHICH placeholders were expected and
 * not what a single one of them would be replaced with. `{{purpose}}`, `{{subjectCounts}}` and
 * `{{digestSectionsHtml}}` are not guessable from their names, and one of them injects raw HTML.
 *
 * `EMAIL_TEMPLATE_TOKEN_HELP` in `@fapoms/shared` describes them, beside the seven every message
 * carries. This spec is the half that keeps it true: the registry decides which placeholders
 * exist, so a template added there with a new token fails HERE — in the file next to it — rather
 * than shipping a chip nobody can explain.
 *
 * `emailTokenHelp()` deliberately never returns empty, so the screen always has a sentence. That
 * fallback is a safety net for production, not a licence to skip this list; the test below is
 * what stops the net from becoming the normal case.
 */
describe('every email placeholder is explained in words', () => {
  const declared = (): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const def of Object.values(EMAIL_TEMPLATE_REGISTRY) as any[]) {
      for (const kind of ['requiredTokens', 'optionalTokens', 'rawTokens'] as const) {
        for (const tok of (def?.[kind] ?? []) as string[]) {
          if (!out.has(tok)) out.set(tok, new Set());
          out.get(tok)!.add(`${def.key}:${kind.replace('Tokens', '')}`);
        }
      }
    }
    return out;
  };

  it('has the registry to read — a guard over nothing passes forever', () => {
    expect(declared().size).toBeGreaterThan(20);
  });

  it('describes every token any template declares', () => {
    const common = new Set<string>(COMMON_MESSAGE_TOKENS as readonly string[]);
    const undescribed: string[] = [];
    for (const [tok, whereUsed] of declared()) {
      if (common.has(tok)) continue;                       // the shared seven have their own map
      if (!EMAIL_TEMPLATE_TOKEN_HELP[tok]) {
        undescribed.push(`{{${tok}}} — used by ${[...whereUsed].join(', ')}`);
      }
    }
    // On failure this prints the token and which template introduced it: add a line to
    // EMAIL_TEMPLATE_TOKEN_HELP saying what the reader will actually receive.
    expect(undescribed).toEqual([]);
  });

  it('explains, rather than restating the name', () => {
    for (const [tok] of declared()) {
      const help = emailTokenHelp(tok);
      expect(help.length).toBeGreaterThan(15);
      // "otpCode: the otpCode" helps nobody. The description must not be the identifier again.
      expect(help.toLowerCase().replace(/[^a-z]/g, '')).not.toBe(tok.toLowerCase());
    }
  });

  it('gives an unknown token a true sentence rather than nothing', () => {
    // A template shipped by a newer backend must not render a chip with an empty tooltip.
    expect(emailTokenHelp('somethingAddedLater')).toMatch(/filled in by the system/i);
  });
});
