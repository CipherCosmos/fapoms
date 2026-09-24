import { translatorFor } from '../i18n/catalogues';
import { en } from '../i18n/locales/en';
import { hi } from '../i18n/locales/hi';
import { reasonText, refusalWords } from './reasons';

const tEn = translatorFor('en');
const tHi = translatorFor('hi');
const SENTENCE = 'You appear to be 3.2 km from this branch.';

describe('why an action is not available', () => {
  it('keeps the server sentence in English', () => {
    expect(reasonText(tEn, 'en', 'TOO_FAR_FROM_BRANCH', SENTENCE, 'today.actionNotAllowed')).toBe(SENTENCE);
  });

  it('translates a known code in another language', () => {
    expect(reasonText(tHi, 'hi', 'TOO_FAR_FROM_BRANCH', SENTENCE, 'today.actionNotAllowed')).toBe(hi.work.reasons.TOO_FAR_FROM_BRANCH);
  });

  it('uses the English sentence for a known code when the server sent none', () => {
    expect(reasonText(tEn, 'en', 'ASSAYER_ON_LEAVE', undefined, 'today.actionNotAllowed')).toBe(en.work.reasons.ASSAYER_ON_LEAVE);
    expect(reasonText(tEn, 'en', 'ASSAYER_ON_LEAVE', 'ASSAYER_ON_LEAVE', 'today.actionNotAllowed')).toBe(en.work.reasons.ASSAYER_ON_LEAVE);
  });

  it('keeps the server sentence for an unknown code, and falls back with nothing at all', () => {
    expect(reasonText(tHi, 'hi', 'SOMETHING_NEW', 'New rule.', 'today.actionNotAllowed')).toBe('New rule.');
    expect(reasonText(tHi, 'hi', undefined, undefined, 'today.actionNotAllowed')).toBe(hi.today.actionNotAllowed);
  });

  it('has a sentence for every code the job routes send', () => {
    for (const code of [
      'ASSAYER_ON_LEAVE', 'NOT_SCHEDULED_TODAY', 'NOT_YOUR_ASSIGNMENT', 'ASSAYER_NOT_ACTIVE', 'INVALID_STATE_FOR_CHECK_IN',
      'ASSAYER_COMPLIANCE_BLOCKED', 'INVALID_ASSIGNMENT_TRANSITION', 'TOO_FAR_FROM_BRANCH', 'ACCEPT_DATE_UNAVAILABLE',
      'REASSIGN_AFTER_CHECK_IN', 'OFFICE_CHECK_IN_REASON_REQUIRED',
    ]) {
      expect(reasonText(tHi, 'hi', code, SENTENCE, 'today.actionNotAllowed')).not.toBe(SENTENCE);
    }
  });
});

describe('a refused queued action', () => {
  it('names the action and the reason', () => {
    const w = refusalWords(tEn, 'en', { kind: 'CHECK_IN', code: 'NOT_SCHEDULED_TODAY', error: 'Scheduled for Friday.' });
    expect(w.title).toBe(`${en.queue.kinds.CHECK_IN} was not accepted`);
    expect(w.line).toBe(`${en.queue.kinds.CHECK_IN}: Scheduled for Friday.`);
    expect(refusalWords(tEn, 'en', { kind: 'CHECK_OUT' }).reason).toBe(en.queue.fallback);
  });
});
