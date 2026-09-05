import * as fs from 'fs';
import * as path from 'path';
import { daysUntilExpiry } from '@fapoms/shared';

/**
 * "Certificate lapsed" is asked in the web app and in SQL, and the two must agree — and the SQL
 * side had its own bug before this change even started.
 *
 * The web app's rule (`hasLapsedCertificate` in `roster-filters.ts`) reads a person's
 * pre-hydrated `certifications` array — already filtered to `type = 'CERTIFICATION'` by
 * `AssayerService.hydrateWorkforceAttributes` before it ever reaches the roster row — and asks
 * whether any entry's `expiryDate` is in the past via the shared `daysUntilExpiry`. This spec
 * cannot import that function (a backend spec importing frontend code is not a boundary this
 * repo crosses), so `personHasLapsedCertificate` below is a transcription of its rule, built on
 * the SAME shared `daysUntilExpiry` primitive, over the RAW `workforce_attributes` shape the SQL
 * actually reads rather than the pre-filtered array the roster hydrates it into.
 *
 * The SQL side is new: `segments()`'s `lapsed` FILTER clause in `hr-workforce.service.ts`. Before
 * this change, the only SQL question asked about certifications was `expiries()`'s `bucketsFor` —
 * and it counted every row in `workforce_attributes` with a matching date, of ANY type (SKILL and
 * LANGUAGE rows included, though neither has ever carried an expiry in practice), with `COUNT(*)`
 * rather than `COUNT(DISTINCT assayer_id)` — so a person holding two lapsed certificates was two
 * "within 30 days", not one. Both fixed in the same pass (see the comment on `bucketsFor`), and
 * `segments()`'s `lapsed` count is the one place this repo now states the rule in three parts:
 * TYPED (`type = 'CERTIFICATION'`), DISTINCT-PERSON (`COUNT(DISTINCT a.id)`, not per row), and
 * EXPIRED (`expiry_date::date < ` today, strictly — not merely due soon).
 *
 * Same technique as `has-left-parity.spec.ts`: read the REAL fragment the service generates,
 * translate only the vocabulary it uses, throw on anything else, run fixtures through both sides.
 */

const SERVICE_PATH = path.join(__dirname, 'hr-workforce.service.ts');

/** The `lapsed` column's own FILTER clause, sliced from the real source — never hand-copied. */
function lapsedFragment(): string {
  const source = fs.readFileSync(SERVICE_PATH, 'utf8');
  const end = source.indexOf('AS "lapsed"');
  expect(end).toBeGreaterThan(-1);
  const start = source.lastIndexOf('COUNT(DISTINCT a.id) FILTER (', end);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, end);
}

/** Just the EXISTS clause's own inner WHERE — the part that runs once per candidate's attribute row. */
function existsBody(fragment: string): string {
  const match = /SELECT 1 FROM workforce_attributes w\s*WHERE ([\s\S]*?)\n\s*\)/.exec(fragment);
  if (!match) {
    throw new Error(
      'The "lapsed" fragment does not contain the EXISTS clause shape this spec expects to '
      + 'translate. Extend the translation below rather than deleting the case.',
    );
  }
  return match[1];
}

/** One row as `workforce_attributes` actually stores it — the level the SQL rule operates at. */
interface AttributeRow {
  type: string;
  isActive?: boolean;
  expiryDate: string | null;
}

/**
 * The EXISTS clause's inner WHERE, evaluated as a boolean expression against one attribute row.
 *
 * Same discipline as `has-left-parity.spec.ts`'s `evaluateFragment`: only the vocabulary the
 * fragment actually contains is recognised, `AND`/`OR` are taken FROM the source rather than
 * assumed, and anything left over after translation throws — so a mutation (the type check
 * dropped, the connective swapped, the comparison flipped) shows up as an unreadable fragment or a
 * wrong answer, never as a silently-passing stale translation.
 */
function evaluateLapsedRow(fragment: string, row: AttributeRow, today: string): boolean {
  const RECOGNISED: [RegExp, string][] = [
    [/w\.assayer_id = a\.id/g, 'true'],
    [/w\.is_active = true/g, 'ISACTIVE'],
    [/w\.type = 'CERTIFICATION'/g, 'ISCERT'],
    [/w\.expiry_date IS NOT NULL/g, 'HASEXPIRY'],
    [/w\.expiry_date::date < \$\{BUSINESS_TODAY_SQL\}/g, 'EXPIRED'],
    [/\bAND\b/g, '&&'],
    [/\bOR\b/g, '||'],
  ];
  let expr = existsBody(fragment);
  for (const [pattern, replacement] of RECOGNISED) expr = expr.replace(pattern, replacement);

  const leftovers = expr.replace(/true|ISACTIVE|ISCERT|HASEXPIRY|EXPIRED|[\s&|()]/g, '');
  if (leftovers.length > 0) {
    throw new Error(
      `The "lapsed" EXISTS clause uses SQL this spec cannot read (${leftovers}). Extend the `
      + 'translation above rather than deleting the case — an unreadable fragment is the state in '
      + 'which this guard is worth the most, not the least.',
    );
  }

  // eslint-disable-next-line no-new-func
  return new Function('ISACTIVE', 'ISCERT', 'HASEXPIRY', 'EXPIRED', `return ${expr};`)(
    row.isActive !== false,
    row.type === 'CERTIFICATION',
    row.expiryDate != null,
    row.expiryDate != null && row.expiryDate < today,
  ) as boolean;
}

/** Does ANY of this person's attribute rows satisfy the SQL's EXISTS clause? */
function sqlLapsed(fragment: string, attrs: AttributeRow[], today: string): boolean {
  return attrs.some((a) => evaluateLapsedRow(fragment, a, today));
}

/**
 * The rule as stated (typed + active + expired), transcribed from `hasLapsedCertificate` in
 * `packages/frontend/src/pages/hr/roster-filters.ts` and built on the same `daysUntilExpiry`
 * primitive that function calls — but applied at the raw attribute-row level, with the type and
 * active checks the frontend's version does not need to make explicit (its `certifications` array
 * arrives already filtered to active `CERTIFICATION` rows; this backend rule reads the table
 * directly and has to do that filtering itself).
 */
function personHasLapsedCertificate(attrs: AttributeRow[]): boolean {
  return attrs.some((a) =>
    a.type === 'CERTIFICATION'
    && a.isActive !== false
    && a.expiryDate != null
    && (daysUntilExpiry(a.expiryDate) ?? 1) < 0);
}

// Wide margins (five and ten days) rather than "yesterday"/"tomorrow"/"today", so the comparison
// can never be flipped by the gap between this test's UTC clock and `daysUntilExpiry`'s IST one —
// see BUSINESS_TODAY_SQL's own comment on exactly that gap. This is not a timezone-correctness
// test; it is a rule-shape test, and it only needs "clearly in the past" and "clearly not".
const DAY_MS = 24 * 60 * 60 * 1000;
const isoDaysFromNow = (offset: number): string => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);
const CLEARLY_EXPIRED = isoDaysFromNow(-10);
const RECENTLY_EXPIRED = isoDaysFromNow(-5);
const NOT_YET_EXPIRED = isoDaysFromNow(5);
const DUE_LATER = isoDaysFromNow(10);

interface PersonFixture {
  name: string;
  attrs: AttributeRow[];
  expected: boolean;
}

const PEOPLE: PersonFixture[] = [
  {
    name: 'one certificate, expired',
    attrs: [{ type: 'CERTIFICATION', expiryDate: CLEARLY_EXPIRED }],
    expected: true,
  },
  {
    name: 'one certificate, not yet due',
    attrs: [{ type: 'CERTIFICATION', expiryDate: NOT_YET_EXPIRED }],
    expected: false,
  },
  {
    name: 'no certifications recorded at all',
    attrs: [],
    expected: false,
  },
  {
    name: 'a certificate with no expiry date on file',
    attrs: [{ type: 'CERTIFICATION', expiryDate: null }],
    expected: false,
  },
  {
    name: 'TYPED: a SKILL row carrying a past date is not a lapsed certificate',
    attrs: [{ type: 'SKILL', expiryDate: CLEARLY_EXPIRED }],
    expected: false,
  },
  {
    name: 'TYPED: a LANGUAGE row carrying a past date is not a lapsed certificate',
    attrs: [{ type: 'LANGUAGE', expiryDate: CLEARLY_EXPIRED }],
    expected: false,
  },
  {
    name: 'an expired certificate that was itself soft-deleted does not count',
    attrs: [{ type: 'CERTIFICATION', isActive: false, expiryDate: CLEARLY_EXPIRED }],
    expected: false,
  },
  {
    name: 'DISTINCT-PERSON: two certificates, one expired one not — still lapsed',
    attrs: [
      { type: 'CERTIFICATION', expiryDate: RECENTLY_EXPIRED },
      { type: 'CERTIFICATION', expiryDate: DUE_LATER },
    ],
    expected: true,
  },
  {
    name: 'DISTINCT-PERSON: two certificates, both expired — still one lapsed person',
    attrs: [
      { type: 'CERTIFICATION', expiryDate: CLEARLY_EXPIRED },
      { type: 'CERTIFICATION', expiryDate: RECENTLY_EXPIRED },
    ],
    expected: true,
  },
  {
    name: 'a mix of an expired SKILL and a not-yet-due certificate — neither lapses them',
    attrs: [
      { type: 'SKILL', expiryDate: CLEARLY_EXPIRED },
      { type: 'CERTIFICATION', expiryDate: DUE_LATER },
    ],
    expected: false,
  },
];

describe('the SQL "certificate lapsed" fragment matches the stated rule', () => {
  const fragment = lapsedFragment();

  it('counts distinct people, not certificate rows', () => {
    expect(fragment).toMatch(/COUNT\(DISTINCT a\.id\)/);
  });

  it('is typed to certifications specifically', () => {
    expect(fragment).toMatch(/w\.type = 'CERTIFICATION'/);
  });

  it('only counts a currently-active attribute row', () => {
    expect(fragment).toMatch(/w\.is_active = true/);
  });

  it('tests the certificate as actually expired (strictly before today), not merely due soon', () => {
    expect(fragment).toMatch(/w\.expiry_date::date < \$\{BUSINESS_TODAY_SQL\}/);
    // "<=" would count something expiring today or later as already lapsed — the SLA scanner's
    // own 180-day lookahead panels use "<=" deliberately, for "falling due"; this key answers a
    // different question, "already gone", and the two must not be confused in either direction.
    expect(fragment).not.toMatch(/w\.expiry_date::date <= \$\{BUSINESS_TODAY_SQL\}/);
  });

  it.each(PEOPLE.map((p) => [p.name, p] as const))('%s', (_name, p) => {
    expect(personHasLapsedCertificate(p.attrs)).toBe(p.expected);
    expect(sqlLapsed(fragment, p.attrs, TODAY)).toBe(p.expected);
  });

  it('agrees with the stated rule over the whole fixture set', () => {
    const oracleCount = PEOPLE.filter((p) => personHasLapsedCertificate(p.attrs)).length;
    const sqlCount = PEOPLE.filter((p) => sqlLapsed(fragment, p.attrs, TODAY)).length;
    expect(sqlCount).toBe(oracleCount);
    expect(oracleCount).toBe(PEOPLE.filter((p) => p.expected).length);
  });

  it('DISTINCT-PERSON: counting people rather than rows changes the answer on this fixture set', () => {
    // Three people lapse: "one certificate, expired" (1 lapsed row), "two certificates, one
    // expired one not" (1 lapsed row of its 2), and "two certificates, both expired" (2 lapsed
    // rows). That is 3 lapsed PEOPLE behind 1 + 1 + 2 = 4 lapsed ROWS — a `COUNT(*)`-shaped rule
    // would read 4 where the correct answer is 3, exactly the `bucketsFor` defect this change also
    // fixes (see the file header). Demonstrated concretely, not just asserted, because a
    // structural check that `COUNT(DISTINCT a.id)` appears in the text (above) would still pass on
    // a fragment that quietly stopped being an EXISTS and started being a per-row FILTER instead.
    const lapsedRowCount = PEOPLE
      .flatMap((p) => p.attrs)
      .filter((a) => evaluateLapsedRow(fragment, a, TODAY)).length;
    const lapsedPersonCount = PEOPLE.filter((p) => sqlLapsed(fragment, p.attrs, TODAY)).length;

    expect(lapsedRowCount).toBeGreaterThan(lapsedPersonCount);
    expect(lapsedPersonCount).toBe(3);
    expect(lapsedRowCount).toBe(4);
  });
});
