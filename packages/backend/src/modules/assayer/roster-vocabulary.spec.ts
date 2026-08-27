import {
  readAvailability, readYesNo, readCibilBand, readBackgroundCheck, readEmpanelment,
  readPhoneNumbers, blankToNull, vocabularyKey,
  AssayerEngagementType, AssayerUnavailableReason, BackgroundCheckVerdict, RiskGrade,
  CibilBand, EmpanelmentStatus,
} from '@fapoms/shared';

/**
 * Reading the roster spreadsheet's own words.
 *
 * The roster is a spreadsheet kept by hand over several years, and one column in it —
 * "Active / Inactive" — holds 29 distinct values across 1,155 people. It is not a status
 * column: it is an availability, a reason and an engagement type written into one cell with a
 * slash, and sometimes none of those at all.
 *
 * Every case below is a real value from that file, with its real frequency where that matters.
 * The rule the tests exist to hold is that ambiguity is *surfaced*, never guessed: a cell
 * nothing can be made of comes back as unreadable so a person decides, because a wrong guess
 * about whether somebody may be sent to a bank branch is worse than an unanswered question.
 */
describe('reading the assayer roster', () => {
  describe('blank', () => {
    it.each(['', '   ', 'N.A', 'n.a', 'NA', '-', 'nil', 'None'])('treats %p as nothing', (raw) => {
      expect(blankToNull(raw)).toBeNull();
    });

    it('keeps a real value', () => {
      expect(blankToNull('  Clear Report ')).toBe('Clear Report');
    });
  });

  describe('case and spacing', () => {
    it('folds the variants the file actually contains', () => {
      // `west`/`West`, `Clear Soft Copy`/`clear soft copy`, `Terminated`/`terminated` are each
      // one answer written several ways. 7 distinct "Zone" values for 4 real regions came from
      // exactly this.
      expect(vocabularyKey('West')).toBe(vocabularyKey('west'));
      expect(vocabularyKey('Clear Soft Copy')).toBe(vocabularyKey('clear soft copy'));
      expect(vocabularyKey('Terminated in Sumeru')).toBe(vocabularyKey('terminated in Sumeru'));
    });
  });

  describe('the "Active / Inactive" column', () => {
    it('reads availability and engagement out of one cell', () => {
      const a = readAvailability('Active / Regular');
      expect(a.available).toBe(true);
      expect(a.engagement).toBe(AssayerEngagementType.REGULAR);
      expect(a.unreadable).toEqual([]);
    });

    it('reads availability and the reason for it', () => {
      // The single commonest value in the file: 241 people.
      const a = readAvailability('Inactive / Sumeru Rejected');
      expect(a.available).toBe(false);
      expect(a.reason).toBe(AssayerUnavailableReason.REJECTED_BY_US);
    });

    it('is not fooled by the casing the file mixes', () => {
      expect(readAvailability('Inactive / sumeru Rejected').reason)
        .toBe(AssayerUnavailableReason.REJECTED_BY_US);
      expect(readAvailability('Active / back up').engagement)
        .toBe(AssayerEngagementType.BACK_UP);
    });

    it('treats Hold as unavailable and says so separately', () => {
      const a = readAvailability('Hold');
      expect({ available: a.available, onHold: a.onHold }).toEqual({ available: false, onHold: true });
    });

    it('surfaces work being done by somebody other than the assayer', () => {
      // 21 rows say this. It is a compliance matter — the person empanelled is not the person
      // attending — and rounding it to "active" would bury it.
      for (const raw of ['Staff doing audit', 'Friend is doing audit', 'Husband doing audit']) {
        const a = readAvailability(raw);
        expect(a.workDoneBySomeoneElse).toBe(true);
        // And it says nothing about availability, so nothing is asserted about it.
        expect(a.available).toBeNull();
      }
    });

    it('leaves availability unknown when the cell only says they are idle', () => {
      // "Not getting audit regular" describes our behaviour, not theirs.
      const a = readAvailability('Not getting audit regular');
      expect(a.available).toBeNull();
      expect(a.reason).toBe(AssayerUnavailableReason.NO_WORK_IN_AREA);
    });

    it('reports what it cannot read rather than guessing', () => {
      const a = readAvailability('Active / promoted to area manager');
      expect(a.available).toBe(true);
      expect(a.unreadable).toEqual(['promoted to area manager']);
    });

    it('reads every one of the 29 real values without a leftover', () => {
      // Taken verbatim from the file. If a new variant appears, this is where it shows up.
      const REAL = [
        'Inactive / Sumeru Rejected', 'Active', 'Inactive / Not Interested', 'Active / Regular',
        'Active / Local', 'Hold', 'Back up', 'Not getting audit regular', 'Active / Back up',
        'Inactive / sumeru Rejected', 'Work not assigned  / No location', 'Staff doing audit',
        'Work not assigned / Back Up', 'Active / Agency Audit', 'Active / Mystry Audit',
        'Not doing audit regular', 'Inactive / Expired', 'Active / back up',
        'Inactive / not Interested', 'Inactive', 'Friend is doing audit', 'Active / Mystry audit',
        'Active / Mystry Audit & Agency Audit', 'Inactive / Sumeru rejected', 'Staff is doing audit',
        'Inactive / Moved to out of India', 'Husband doing audit', 'Inactive / expired',
        'Inactive / Company profile added',
      ];
      const leftovers = REAL.flatMap((raw) => readAvailability(raw).unreadable.map((u) => `${raw} → ${u}`));
      expect(leftovers).toEqual([]);
    });
  });

  describe('yes/no columns', () => {
    it.each([['Yes', true], ['Received', true], ['Clear Soft Copy', true], ['clear soft copy', true],
             ['No', false], ['Pending', false], ['soft copy not clear', false]] as const)(
      'reads %p as %p', (raw, expected) => expect(readYesNo(raw)).toBe(expected),
    );

    it('answers nothing for a value it does not recognise', () => {
      expect(readYesNo('Sent to Bangalore office')).toBeNull();
    });
  });

  describe('credit checks', () => {
    it.each([['Good', CibilBand.GOOD], ['GOOD', CibilBand.GOOD], ['Bad', CibilBand.BAD],
             ['Poor', CibilBand.POOR], ['Average', CibilBand.AVERAGE]] as const)(
      'reads %p', (raw, expected) => expect(readCibilBand(raw)).toBe(expected),
    );

    it('separates no credit history from not having looked', () => {
      // 67 people have no bureau file. That is an answer, not a gap.
      expect(readCibilBand('No credit')).toBe(CibilBand.NO_CREDIT_HISTORY);
      expect(readCibilBand('No Credit')).toBe(CibilBand.NO_CREDIT_HISTORY);
      expect(readCibilBand('Inactive')).toBe(CibilBand.NOT_CHECKED);
      expect(readCibilBand('Error')).toBe(CibilBand.CHECK_FAILED);
    });
  });

  describe('background checks', () => {
    it('separates the verdict from the risk grade', () => {
      expect(readBackgroundCheck('Criminal Case / Civil Case / Very High risk'))
        .toEqual({ verdict: BackgroundCheckVerdict.CRIMINAL_CASE, risk: RiskGrade.VERY_HIGH });
      expect(readBackgroundCheck('Civil case / Low Risk'))
        .toEqual({ verdict: BackgroundCheckVerdict.CIVIL_CASE, risk: RiskGrade.LOW });
    });

    it('reads the findings the file names directly rather than by category', () => {
      expect(readBackgroundCheck('Dishonor of Cheque').verdict).toBe(BackgroundCheckVerdict.CIVIL_CASE);
      expect(readBackgroundCheck('Divorce Case').verdict).toBe(BackgroundCheckVerdict.CIVIL_CASE);
      expect(readBackgroundCheck('Discrepancy').verdict).toBe(BackgroundCheckVerdict.ADVERSE_FINDING);
    });

    it('does not read an availability note as a clean background check', () => {
      // "Staff doing audit" appears in this column too — the wrong column, and it must not be
      // rounded to CLEAR just because nothing adverse was named.
      expect(readBackgroundCheck('Staff doing audit').verdict).toBeNull();
      expect(readBackgroundCheck('Agency Audit').verdict).toBeNull();
    });
  });

  describe('client empanelment', () => {
    it.each([['Not recommended for ICIC', EmpanelmentStatus.NOT_RECOMMENDED],
             ['Recommended / No documents as per ICICI', EmpanelmentStatus.DOCUMENTS_PENDING],
             ['Rejected ICICI', EmpanelmentStatus.REJECTED],
             ['Terminated / Fake not identified', EmpanelmentStatus.TERMINATED],
             ['Resigned in ICICI / Not Interested', EmpanelmentStatus.RESIGNED],
             ['Active', EmpanelmentStatus.ACTIVE]] as const)(
      'reads %p', (raw, expected) => expect(readEmpanelment(raw)).toBe(expected),
    );

    it('prefers the more specific reading when a value contains both words', () => {
      // "Not recommended" contains "recommended"; the negative has to win.
      expect(readEmpanelment('Not recommended for ICIC')).toBe(EmpanelmentStatus.NOT_RECOMMENDED);
    });
  });

  describe('phone numbers', () => {
    it('splits the several numbers the file puts in one cell', () => {
      // The second phone column routinely holds two numbers separated by a slash.
      expect(readPhoneNumbers('9404410787', '9890366641 / 9850042526'))
        .toEqual(['+919404410787', '+919890366641', '+919850042526']);
    });

    it('normalises to one shape so the same number is not stored twice', () => {
      expect(readPhoneNumbers('9404410787', '+91 94044 10787')).toEqual(['+919404410787']);
    });

    it('drops anything that is not a ten-digit Indian mobile', () => {
      expect(readPhoneNumbers('N.A', '12345', 'landline 0712-2345678')).toEqual([]);
    });
  });
});
