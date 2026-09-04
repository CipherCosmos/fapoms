import * as xlsx from 'xlsx';
import { RosterImportService } from './roster-import.service';
import { lookupIfsc } from '../geo/ifsc-lookup.helper';

/**
 * Three independent cross-checks added on top of the existing importer, all covered here rather
 * than spread across the other roster-import spec files so each can be read against the change
 * that motivated it:
 *
 *   1. the State column is run through the shared state canonicalisers on import, so "kerala" and
 *      "Kerala" land as the one stored form the rest of the system already expects, and a value
 *      neither canonicaliser recognises is kept (never dropped) with a review issue instead;
 *   2. a state that disagrees with what the record's own pincode and address say is flagged for
 *      review rather than trusted silently;
 *   3. a typed Bank Name that disagrees with what the IFSC code itself resolves to is replaced by
 *      the IFSC-derived name, with an issue explaining what was overridden and why — and a lookup
 *      that fails, times out, or is simply unavailable must never block the row: the sheet's own
 *      bank name is what lands.
 */
jest.mock('../geo/ifsc-lookup.helper');
const mockedLookupIfsc = lookupIfsc as jest.MockedFunction<typeof lookupIfsc>;

describe('roster import — state and bank cross-checks', () => {
  const HEADERS = [
    'Appraiser Name', 'Appraiser code', 'PAN Number', 'Residence Address', 'Location', 'District',
    'State', 'Bank Name', 'IFSC Code',
  ];

  const row = (over: Partial<Record<typeof HEADERS[number], string>> = {}): any[] => {
    const base: Record<string, string> = {
      'Appraiser Name': 'Shinil T',
      'Appraiser code': 'AS0001',
      'PAN Number': '',
      'Residence Address': 'Main Road, Kunnamangalam',
      'Location': 'Kunnamangalam',
      'District': 'Calicut',
      'State': 'Kerala',
      'Bank Name': '',
      'IFSC Code': '',
      ...over,
    };
    return HEADERS.map((h) => base[h]);
  };

  const book = (rows: any[][]): Buffer => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([HEADERS, ...rows]), 'Assayer');
    return Buffer.from(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  };

  /** Same shape as the de-duplication harness in roster-import.spec.ts, reused rather than reinvented. */
  const harness = (opts: { existing?: Array<Record<string, any>> } = {}) => {
    const existing = opts.existing ?? [];
    const savedAssayers: any[] = [];
    const savedIssues: any[] = [];
    let n = 1;

    const manager: any = {
      find: async () => [],
      createQueryBuilder: (entity: any) => {
        let codes: string[] = [];
        const qb: any = {
          where: (_sql: string, params?: any) => { codes = params?.codes ?? codes; return qb; },
          getMany: async () => (entity?.name !== 'AssayerEntity' ? [] : existing.filter((a) => codes.includes(a.assayerCode))),
        };
        qb.andWhere = qb.where;
        return qb;
      },
      findOne: async () => undefined,
      query: async () => undefined,
      create: (_entity: any, obj: any) => ({ ...obj }),
      save: async (entity: any, obj: any) => {
        if (obj && obj.id == null) obj.id = `id-${n++}`;
        if (entity?.name === 'AssayerEntity') savedAssayers.push(obj);
        if (entity?.name === 'AssayerImportIssueEntity') savedIssues.push(obj);
        return obj;
      },
    };

    const service = new RosterImportService(
      { run: (work: any) => work(manager, () => {}) } as any,
      { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockResolvedValue(false) } as any,
    );

    return { service, savedAssayers, savedIssues };
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Task 1 — state canonicalisation', () => {
    it('canonicalises a recognised but differently-spelled state, filing no review issue', async () => {
      const h = harness();
      await h.service.importAssayerSheet(book([row({ State: 'kerala' })]), 'user-1', {});

      expect(h.savedAssayers[0].state).toBe('Kerala');
      expect(h.savedIssues.filter((i) => i.sourceColumn === 'State')).toHaveLength(0);
    });

    it('canonicalises an abbreviation the primary canonicaliser alone does not answer', async () => {
      const h = harness();
      // "A.P" is one of the exact abbreviated forms canonicalStateName's own docs say it
      // refuses; the secondary canonicaliser is what has to carry this one.
      await h.service.importAssayerSheet(book([row({ State: 'A.P' })]), 'user-1', {});

      expect(h.savedAssayers[0].state).toBe('Andhra Pradesh');
      expect(h.savedIssues.filter((i) => i.sourceColumn === 'State')).toHaveLength(0);
    });

    /**
     * The capability-preservation guarantee: an unrecognised state is never dropped. Before this
     * change the cell was stored verbatim and silently; now it is still stored verbatim, but with
     * a named review issue — this is the mutation-killing assertion for "never silently drop".
     */
    it('keeps an unrecognised state exactly as written, and files a review issue naming it', async () => {
      const h = harness();
      await h.service.importAssayerSheet(book([row({ State: 'Narnia' })]), 'user-1', {});

      expect(h.savedAssayers[0].state).toBe('Narnia');
      const issue = h.savedIssues.find((i) => i.sourceColumn === 'State');
      expect(issue).toBeDefined();
      expect(issue.reason).toBe('Could not recognize this as a state — stored as written; please confirm.');
    });

    it('does not touch state at all when the cell is blank, on a new row', async () => {
      const h = harness();
      await h.service.importAssayerSheet(book([row({ State: '' })]), 'user-1', {});

      // `fillRequiredBlanks` coerces the still-null state to '' for the NOT NULL column — the
      // point under test is that no canonicalisation or issue-filing ran on a blank cell.
      expect(h.savedAssayers[0].state).toBe('');
      expect(h.savedIssues.filter((i) => i.sourceColumn === 'State')).toHaveLength(0);
    });
  });

  describe('Task 2 — state vs pincode/address cross-check', () => {
    it('files a review issue when the stored state disagrees with what the pincode and address say', async () => {
      // The person is already on file with a pincode from a prior import; this re-import's sheet
      // supplies a State column that the pincode's own postal circle, and the address text, both
      // contradict — mirroring the real records `stateFromAddressAndPincode`'s own docs describe.
      const h = harness({ existing: [{ id: 'a-1', assayerCode: 'AS0001', pincode: '700001' }] });

      await h.service.importAssayerSheet(
        book([row({ 'Residence Address': '12 Park Street, West Bengal', State: 'Uttar Pradesh' })]),
        'user-1', {},
      );

      expect(h.savedAssayers[0].pincode).toBe('700001');
      expect(h.savedAssayers[0].state).toBe('Uttar Pradesh');
      const issue = h.savedIssues.find((i) => i.sourceColumn === 'State' && /West Bengal/.test(i.reason));
      expect(issue).toBeDefined();
      expect(issue.reason).toContain('Uttar Pradesh');
    });

    it('files no issue when the pincode and the state agree', async () => {
      const h = harness({ existing: [{ id: 'a-1', assayerCode: 'AS0001', pincode: '700001' }] });

      await h.service.importAssayerSheet(
        book([row({ 'Residence Address': '12 Park Street, West Bengal', State: 'West Bengal' })]),
        'user-1', {},
      );

      expect(h.savedIssues.filter((i) => i.sourceColumn === 'State')).toHaveLength(0);
    });
  });

  describe('Task 3 — IFSC-preferred bank name', () => {
    it('prefers the IFSC-derived bank name over a clearly disagreeing typed one, and says why', async () => {
      mockedLookupIfsc.mockResolvedValue({
        bankName: 'State Bank of India', branchName: 'MAIN', city: null, state: null, address: null,
      });
      const h = harness();

      await h.service.importAssayerSheet(
        book([row({ 'Bank Name': 'SBI', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );

      expect(h.savedAssayers[0].bankName).toBe('State Bank of India');
      const issue = h.savedIssues.find((i) => i.sourceColumn === 'Bank Name');
      expect(issue).toBeDefined();
      expect(issue.reason).toContain('State Bank of India');
      expect(issue.reason).toContain('SBI');
    });

    it('keeps the sheet name when it only differs from the IFSC answer by "Bank"/"Ltd" noise', async () => {
      mockedLookupIfsc.mockResolvedValue({
        bankName: 'State Bank Of India', branchName: 'MAIN', city: null, state: null, address: null,
      });
      const h = harness();

      await h.service.importAssayerSheet(
        book([row({ 'Bank Name': 'State Bank of India Ltd', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );

      expect(h.savedAssayers[0].bankName).toBe('State Bank of India Ltd');
      expect(h.savedIssues.filter((i) => i.sourceColumn === 'Bank Name')).toHaveLength(0);
    });

    /**
     * Capability preservation: a lookup that fails must never block the row or lose the sheet's
     * bank name. `lookupIfsc` itself never throws, but this proves the importer's own fallback
     * holds even if it did — and that nothing about the row's import is skipped or delayed.
     */
    it('falls back to the sheet bank name, and still imports the row, when the lookup fails', async () => {
      mockedLookupIfsc.mockRejectedValue(new Error('network down'));
      const h = harness();

      const summary = await h.service.importAssayerSheet(
        book([row({ 'Bank Name': 'SBI', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );

      expect(summary.created).toBe(1);
      expect(h.savedAssayers[0].bankName).toBe('SBI');
      expect(h.savedIssues.filter((i) => i.sourceColumn === 'Bank Name')).toHaveLength(0);
    });

    it('falls back to the sheet bank name when the lookup resolves nothing (unknown code)', async () => {
      mockedLookupIfsc.mockResolvedValue(null);
      const h = harness();

      await h.service.importAssayerSheet(
        book([row({ 'Bank Name': 'SBI', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );

      expect(h.savedAssayers[0].bankName).toBe('SBI');
    });

    /**
     * The lookup is only worth making when there is a typed name to compare against — an IFSC
     * with no Bank Name cell has nothing to cross-check, so this must not spend a network call.
     */
    it('never calls the lookup when the sheet has no bank name to compare against', async () => {
      const h = harness();

      await h.service.importAssayerSheet(
        book([row({ 'Bank Name': '', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );

      expect(mockedLookupIfsc).not.toHaveBeenCalled();
    });

    it('times out fast rather than hanging the import when the lookup never resolves', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick'] });
      mockedLookupIfsc.mockImplementation(() => new Promise(() => {}));
      const h = harness();

      const pending = h.service.importAssayerSheet(
        book([row({ 'Bank Name': 'SBI', 'IFSC Code': 'SBIN0001234' })]),
        'user-1', {},
      );
      await jest.advanceTimersByTimeAsync(3500);
      await pending;

      expect(h.savedAssayers[0].bankName).toBe('SBI');
      jest.useRealTimers();
    });
  });
});
