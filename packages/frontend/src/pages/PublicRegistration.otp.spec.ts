import * as fs from 'fs';
import * as path from 'path';
import { registrationStepProblems, type RegistrationFormValues } from '@fapoms/shared';

/**
 * THE CODE BOX THE CANDIDATE COULD NOT SEE.
 *
 * This page is served BEFORE the app applies a theme — App.tsx returns it early, with no account
 * and no session — so it always renders on the default light palette. Its stylesheet, though, was
 * written for a dark ground: placeholders at `rgba(247, 239, 231, 0.48)` and borders at
 * `rgba(255, 236, 220, 0.22)`, both near-white. On the light page that painted white on white:
 * the one-time-code box had no visible outline and its `••••••` placeholder did not show, so the
 * field read as empty space and the candidate had nothing to aim at.
 *
 * A near-white literal is the whole class of bug, so this reads the stylesheet the page ships and
 * refuses one. Comments are stripped first — the explanation above quotes the very colours it
 * bans, and a guard that matches its own reasoning is a guard that fails for the wrong reason.
 */
/*
  The page, and the shell it is drawn in.

  `FORM_CSS` and the masthead moved into `registration/PublicShell.tsx` when staff gained a second
  page reachable without signing in (the emailed "choose your password" link) and the choice was
  between copying a company header or sharing one. These rules are about what a stranger's browser
  renders, which is both files — so both are read here.
*/
const SOURCE = [
  fs.readFileSync(path.join(__dirname, 'PublicRegistration.tsx'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'registration', 'PublicShell.tsx'), 'utf8'),
  fs.readFileSync(path.join(__dirname, 'registration', 'ConsentGate.tsx'), 'utf8'),
].join('\n');

/** The `.pub-reg-*` rules in the app stylesheet — the page's other half. */
const PAGE_CSS = (() => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  const start = css.indexOf('.pub-reg-root {');
  const end = css.indexOf('/* ---', css.indexOf('.pub-reg-roadmap-item'));
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, end > start ? end : undefined).replace(/\/\*[\s\S]*?\*\//g, '');
})();

/** The page's inline stylesheet, comments removed. */
function formCss(): string {
  const start = SOURCE.indexOf('const FORM_CSS = `');
  const end = SOURCE.indexOf('`;', start);
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the public form is legible on the palette it is actually served with', () => {
  /** The whole screen, comments removed — the stylesheet was only where this bug was found first. */
  function sourceWithoutComments(): string {
    return SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  it('sets no near-white text or border colour of its own — the page is light, and those vanish', () => {
    const lines = sourceWithoutComments().split('\n');
    const offenders = lines.filter((line) => (
      /rgba\(\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,/.test(line)
      // A translucent wash BEHIND something is fine — it is a tint on whatever ground it lands on.
      // A colour something is drawn IN is not: that is the white-on-white case.
      && /(^|[^-\w])color\s*:|border(-color)?\s*:|border:\s*'?[\d.]+px/i.test(line)
    ));
    expect(offenders).toEqual([]);
  });

  it('draws placeholders and borders from the palette, so they follow whatever ground they land on', () => {
    const css = formCss();
    expect(css).toMatch(/::placeholder[\s\S]*?color:\s*var\(--text-muted\)/);
    expect(css).toMatch(/border-color:\s*var\(--border-color\)/);
  });

  it('keeps the same rule in the stylesheet half of the page', () => {
    const offenders = PAGE_CSS.split('\n').filter((line) => (
      /rgba\(\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,\s*2[0-5]\d\s*,/.test(line)
      && /(^|[^-\w])color\s*:|border(-color)?\s*:/i.test(line)
    ));
    expect(offenders).toEqual([]);
  });

  it('gives the one-time code its own visible box, not a bare input', () => {
    const css = formCss();
    expect(css).toMatch(/\.reg-code-input\s*\{/);
    expect(css).toMatch(/\.reg-code-input[\s\S]*?border-width:\s*2px/);
  });
});

describe('entering the code', () => {
  it('verifies as soon as six digits are in, instead of asking for a click as well', () => {
    // The handler is called with what was just typed, not with `code` from a stale render.
    expect(SOURCE).toMatch(/if \(next\.length === 6 && !otpBusy\) void handleVerifyCode\(next\)/);
    expect(SOURCE).toMatch(/const handleVerifyCode = async \(submitted\?: string\)/);
    expect(SOURCE).toMatch(/const entered = \(submitted \?\? code\)\.trim\(\)/);
  });

  it('puts the cursor in the box when it appears', () => {
    expect(SOURCE).toMatch(/if \(codeSent && !otpVerified\) codeRef\.current\?\.focus\(\)/);
  });

  it('shows digits rather than dots, so a mistyped code can be spotted', () => {
    expect(SOURCE).toMatch(/placeholder="000000"/);
    expect(SOURCE).not.toMatch(/placeholder="••••••"/);
  });
});

/**
 * WHAT THE REDESIGN TOOK OUT, AND WHY IT MUST STAY OUT.
 *
 * The rail carried four cards and the column beside it repeated the same progress: a step pill, a
 * percentage, a second progress bar and a second row of step buttons. Progress was stated three
 * times on one screen, and the form started below all of it. These pin the single statement, so a
 * future "let's show progress here too" has to argue with a test first.
 */
describe('the page says where you are exactly once', () => {
  const SHELL = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

  it('states the percentage complete nowhere — the rail shows which step is current', () => {
    expect(SHELL).not.toMatch(/% Complete/i);
    expect(SHELL).not.toMatch(/Math\.round\(\(activeStep/);
  });

  it('draws one progress bar, in the compact header that only narrow screens see', () => {
    expect(SHELL.match(/pub-reg-progress-fill/g) ?? []).toHaveLength(1);
    expect(PAGE_CSS).toMatch(/@media \(min-width: 1080px\)[\s\S]*?\.pub-reg-compact-head[\s\S]*?display: none/);
  });

  it('lists the steps once, in the rail', () => {
    expect(SHELL.match(/WIZARD_STEPS\.map/g) ?? []).toHaveLength(1);
  });

  it('does not repeat the step number above every section', () => {
    expect(SHELL).not.toMatch(/Step \d+ ·/);
  });

  it('uses one card surface for every panel, not two that nearly match', () => {
    expect(SHELL).not.toMatch(/SECTION_STYLE/);
  });
});

/**
 * ONE CLASH, ONE SENTENCE.
 *
 * The blur check wrote the server's wording under the number; pressing "Send verification code"
 * then wrote a SECOND notice under the button — reaching for `phoneConflict`, which is state and
 * one render behind, so on the first press it was null and a hard-coded "This mobile number is
 * already registered with someone else." was used instead. The candidate saw the same problem
 * described twice, in two different voices, one of which the server had stopped saying.
 */
describe('a number that clashes is reported once, in the server’s words', () => {
  const SHELL = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('keeps no hard-coded copy of the old sentence', () => {
    expect(SHELL).not.toMatch(/already registered with someone else/);
  });

  it('hands the sentence back from the check instead of guessing at one', () => {
    expect(SHELL).toMatch(/checkPhoneConflictFn = useCallback\(async \(phoneValue: string\): Promise<string \| null>/);
  });

  it('never writes a second notice under the button when the field already carries it', () => {
    expect(SHELL).toMatch(/if \(await checkPhoneConflictFn\(norm\)\) return;/);
    expect(SHELL).not.toMatch(/setOtpError\(phoneConflict/);
  });
});

/**
 * VALIDATION THAT USED TO ARRIVE AFTER APPROVAL.
 *
 * The form checked that a date of birth was real, after 1930 and not in the future — and said
 * nothing about age, because the 18-to-90 rule lived in the nightly roster sweep. A seventeen-
 * year-old could fill the whole form, submit, be approved, and surface days later as a finding in
 * HR's review queue. The rule now lives in `@fapoms/shared` so the form and the submit refuse the
 * same dates in the same words.
 */
describe('the form asks the questions the server will ask later', () => {
  const SHELL = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('will not let a step pass with no date of birth', () => {
    // The step rules are shared with the phone app's registration; the page must use them, not its own.
    expect(SHELL).toMatch(/registrationStepProblems\(step, f\)/);
    const f = Object.fromEntries(
      ['fullName', 'email', 'dateOfBirth'].map((k) => [k, k === 'fullName' ? 'Ramesh Kumar Sharma' : '']),
    ) as unknown as RegistrationFormValues;
    expect(registrationStepProblems(1, f).dateOfBirth).toEqual({ code: 'required' });
  });

  it('judges the date with the shared rule rather than a second opinion of its own', () => {
    const options = fs.readFileSync(path.join(__dirname, '..', 'config', 'registration-options.ts'), 'utf8');
    expect(options).toMatch(/return dateOfBirthProblem\(value\)/);
    // The old local reading — real date, after 1930, not future — knew nothing about age.
    expect(options).not.toMatch(/That date looks too far back/);
  });
});
