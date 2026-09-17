import {
  ageInYears, dateOfBirthProblem, APPRAISER_MIN_AGE, APPRAISER_MAX_AGE,
} from './assayer-record';

/**
 * The age rule, at the door rather than a week later.
 *
 * `data-integrity.service.ts` has always refused 18–90, but only by sweeping rows that already
 * exist: a seventeen-year-old could register, be approved and reach the roster, and HR met the
 * problem as a review-queue finding afterwards. These pin the rule the form and the submit now
 * share, including the boundary nobody tests by hand — the birthday itself.
 */
const ON = new Date(2026, 8, 16); // 16 Sep 2026, local

describe('how old the date of birth makes somebody', () => {
  it('counts whole years, not calendar years', () => {
    expect(ageInYears('2000-09-16', ON)).toBe(26);
    // Birthday tomorrow: still 25 today.
    expect(ageInYears('2000-09-17', ON)).toBe(25);
  });

  it('says nothing about a date it cannot read', () => {
    expect(ageInYears('not a date', ON)).toBeNull();
  });
});

describe('what the candidate is told about their date of birth', () => {
  it('accepts somebody who turned 18 today, and refuses somebody who turns 18 tomorrow', () => {
    expect(dateOfBirthProblem('2008-09-16', ON)).toBeNull();
    expect(dateOfBirthProblem('2008-09-17', ON)).toMatch(/at least 18/);
  });

  it('names the age it worked out, so the candidate can see which digit is wrong', () => {
    expect(dateOfBirthProblem('2010-01-01', ON)).toContain('makes you 16');
  });

  it('refuses a future date and an implausible year separately', () => {
    expect(dateOfBirthProblem('2027-01-01', ON)).toMatch(/cannot be in the future/);
    expect(dateOfBirthProblem('1899-01-01', ON)).toMatch(/before 1930/);
  });

  it('refuses an age past the top of the range', () => {
    expect(dateOfBirthProblem('1930-01-02', ON)).toMatch(/past the age we can register/);
  });

  it('passes an ordinary working age, and says nothing when the box is empty', () => {
    expect(dateOfBirthProblem('1990-06-15', ON)).toBeNull();
    expect(dateOfBirthProblem('', ON)).toBeNull();
    expect(dateOfBirthProblem(null, ON)).toBeNull();
  });

  it('agrees with the range the roster sweep polices', () => {
    expect(APPRAISER_MIN_AGE).toBe(18);
    expect(APPRAISER_MAX_AGE).toBe(90);
  });
});
