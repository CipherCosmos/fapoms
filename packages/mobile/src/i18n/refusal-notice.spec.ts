jest.mock('expo-localization', () => ({ getLocales: () => [] }));

// eslint-disable-next-line import/first
import { applyLanguagePreference } from './i18n';
// eslint-disable-next-line import/first
import { refusalNotice } from './refusal-notice';
// eslint-disable-next-line import/first
import { en } from './locales/en';

afterEach(() => applyLanguagePreference('en'));

describe('what the assayer is told about a refused queued action', () => {
  it('names the action and keeps the server sentence in English', () => {
    const n = refusalNotice({ kind: 'CHECK_IN', error: 'This audit is scheduled for Friday, 26 September.', code: 'NOT_SCHEDULED_TODAY' });
    expect(n.what).toBe(en.queue.kinds.CHECK_IN);
    expect(n.reason).toBe('This audit is scheduled for Friday, 26 September.');
    expect(n.title).toBe(`${en.queue.kinds.CHECK_IN} was not accepted`);
    expect(n.line).toBe(`${en.queue.kinds.CHECK_IN}: This audit is scheduled for Friday, 26 September.`);
  });

  it('translates the reason by its code in Hindi', () => {
    applyLanguagePreference('hi');
    const n = refusalNotice({ kind: 'EXPENSE_CLAIM', error: 'You appear to be 3.2 km from this branch.', code: 'TOO_FAR_FROM_BRANCH' });
    expect(n.reason).not.toContain('3.2 km');
    expect(n.what).not.toBe(en.queue.kinds.EXPENSE_CLAIM);
  });

  it('says something when the server gave no reason', () => {
    expect(refusalNotice({ kind: 'CHECK_OUT' }).reason).toBe(en.queue.refusedFallback);
  });

  it('uses the translated sentence when only a code came back', () => {
    expect(refusalNotice({ kind: 'ASSIGNMENT_STATUS', code: 'ASSAYER_ON_LEAVE' }).reason).toBe(en.errors.assayerOnLeave);
  });
});
