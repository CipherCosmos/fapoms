import { AssayerLifecycleStatus } from '@fapoms/shared';

import {
  ROSTER_FILTERS, ROSTER_SEGMENTS, EMPTY_FILTERS, NOT_RECORDED,
  applyRosterFilters, availableFilters, fieldChoices, ruleChoices, describeFilters,
  toggleChoice, clearFilter, activeFilterCount, parseFilters, writeFilters, pinQuality,
  type FieldFilter, type RuleFilter, type RosterFilterState, type RosterPerson,
} from './roster-filters';

/**
 * The filters, held to the two promises the screen makes about them.
 *
 * "Options under one heading widen the list; separate headings narrow it" is printed above the
 * panel, and a clerk builds every question they ask on top of it — so OR-within/AND-across is
 * pinned here rather than left to the reading of one `.filter()` chain. The rest of these are
 * the cases that quietly go wrong: a blank value that has to be findable, a count that must not
 * zero out the moment you tick something, a date range meeting a person with no date, and a URL
 * that has to survive being pasted to a colleague without losing `?assayer=`.
 */

const person = (over: Partial<RosterPerson> = {}): RosterPerson => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  employeeId: null,
  employeeCode: null,
  firstName: 'Person',
  lastName: 'One',
  displayName: 'Person One',
  email: 'p1@example.com',
  phone: '+919000000000',
  alternatePhone: null,
  address: '1 Road',
  state: 'Kerala',
  district: 'Ernakulam',
  city: 'Kochi',
  pincode: '682001',
  latitude: 9.9,
  longitude: 76.2,
  geoSource: 'geocoder',
  geoAccuracyMeters: 60,
  status: 'ACTIVE',
  lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
  organizationId: null,
  panNumber: 'ABCDE1234F',
  bankAccountNumber: '000111222333',
  ifscCode: 'HDFC0000001',
  notes: null,
  employmentType: 'INTERNAL',
  joiningDate: '2024-01-01',
  exitDate: null,
  terminationDate: null,
  managerId: null,
  department: null,
  region: 'South',
  emergencyContactName: null,
  emergencyContactPhone: '+919000000001',
  emergencyContactRelation: null,
  photograph: null,
  skills: ['Gold'],
  certifications: null,
  languages: ['Malayalam'],
  preferredRegions: null,
  specializations: null,
  experienceYears: 4,
  performanceRating: 3,
  leaves: null,
  workingHours: null,
  maxDailyWorkload: 3,
  maxWeeklyWorkload: 15,
  ...over,
});

const state = (over: Partial<RosterFilterState> = {}): RosterFilterState => ({ ...EMPTY_FILTERS, ...over });

/** The definition behind one filter, narrowed to the kind the test is about. */
const fieldDef = (key: string): FieldFilter => {
  const def = ROSTER_FILTERS.find((f) => f.key === key);
  if (!def || def.kind !== 'field') throw new Error(`${key} is not a field filter`);
  return def;
};
const ruleDef = (key: string): RuleFilter => {
  const def = ROSTER_FILTERS.find((f) => f.key === key);
  if (!def || def.kind !== 'rule') throw new Error(`${key} is not a rule filter`);
  return def;
};

const names = (rows: RosterPerson[]) => rows.map((r) => r.displayName);

describe('combining filters', () => {
  const roster = [
    person({ id: '1', displayName: 'Kerala Payable', state: 'Kerala' }),
    person({ id: '2', displayName: 'Kerala Unpayable', state: 'Kerala', bankAccountNumber: null }),
    person({ id: '3', displayName: 'Goa Payable', state: 'Goa', district: 'North Goa' }),
    person({ id: '4', displayName: 'Delhi Unpayable', state: 'Delhi', district: 'New Delhi', bankAccountNumber: null }),
  ];

  it('widens within one filter: two states means either state', () => {
    const chosen = state({ choices: { state: ['Kerala', 'Goa'] } });
    expect(names(applyRosterFilters(roster, chosen)).sort())
      .toEqual(['Goa Payable', 'Kerala Payable', 'Kerala Unpayable']);
  });

  it('narrows across filters: a state AND a record problem', () => {
    const chosen = state({ choices: { state: ['Kerala'], record: ['unpayable'] } });
    expect(names(applyRosterFilters(roster, chosen))).toEqual(['Kerala Unpayable']);
  });

  it('combines a queue chip with a filter, which is what chips alone could never do', () => {
    // The "Cannot be paid" chip answers "who", the state filter answers "where"; together they
    // answer the question a regional clerk actually has.
    const chosen = state({ segment: 'unpayable', choices: { state: ['Delhi'] } });
    expect(names(applyRosterFilters(roster, chosen))).toEqual(['Delhi Unpayable']);
  });

  it('counts every criterion in force — one per pill, segment and search included', () => {
    const chosen = state({ segment: 'unpayable', search: 'kochi', choices: { state: ['Kerala', 'Goa'] } });
    expect(activeFilterCount(chosen)).toBe(4);
    // The badge on the Filters button and the pills under the toolbar are the same number.
    expect(activeFilterCount(chosen)).toBe(describeFilters(chosen).length);
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
  });
});

describe('the people with nothing recorded', () => {
  const roster = [
    person({ id: '1', displayName: 'Has Region', region: 'South' }),
    person({ id: '2', displayName: 'No Region', region: null }),
    person({ id: '3', displayName: 'Blank Region', region: '   ' }),
  ];
  it('offers "no region set" as an option, because that is the question worth asking', () => {
    const options = fieldChoices(fieldDef('region'), roster);
    expect(options.find((o) => o.value === NOT_RECORDED)).toEqual({
      value: NOT_RECORDED, label: 'No region set', count: 2,
    });
  });

  it('finds them, counting whitespace as blank the way the record does', () => {
    const chosen = state({ choices: { region: [NOT_RECORDED] } });
    expect(names(applyRosterFilters(roster, chosen)).sort()).toEqual(['Blank Region', 'No Region']);
  });
});

describe('the count beside each option', () => {
  const roster = [
    person({ id: '1', state: 'Kerala', lifecycleStatus: AssayerLifecycleStatus.ACTIVE }),
    person({ id: '2', state: 'Kerala', lifecycleStatus: AssayerLifecycleStatus.SUSPENDED }),
    person({ id: '3', state: 'Goa', lifecycleStatus: AssayerLifecycleStatus.ACTIVE }),
  ];

  it('is measured with that filter left out, so ticking one option does not zero the rest', () => {
    const chosen = state({ choices: { state: ['Kerala'] } });
    // The scope the panel hands the state filter: everything else applied, this axis open.
    const scope = applyRosterFilters(roster, chosen, ROSTER_FILTERS, 'state');
    const options = fieldChoices(fieldDef('state'), scope);
    expect(options.find((o) => o.value === 'Goa')?.count).toBe(1);
    expect(options.find((o) => o.value === 'Kerala')?.count).toBe(2);
  });

  it('does honour the other filters, so the number is what you would actually get', () => {
    const chosen = state({ choices: { stage: [AssayerLifecycleStatus.ACTIVE] } });
    const scope = applyRosterFilters(roster, chosen, ROSTER_FILTERS, 'state');
    const options = fieldChoices(fieldDef('state'), scope);
    expect(options.find((o) => o.value === 'Kerala')?.count).toBe(1);
  });

  it('counts a person with several skills once against each, never three times against one', () => {
    const many = [person({ id: '1', skills: ['Gold', 'Diamond'] }), person({ id: '2', skills: ['Gold'] })];
    const options = fieldChoices(fieldDef('skill'), many);
    expect(options.find((o) => o.value === 'Gold')?.count).toBe(2);
    expect(options.find((o) => o.value === 'Diamond')?.count).toBe(1);
  });
});

describe('date ranges', () => {
  const roster = [
    person({ id: '1', displayName: 'Joined April', joiningDate: '2024-04-10T00:00:00.000Z' }),
    person({ id: '2', displayName: 'Joined June', joiningDate: '2024-06-30T00:00:00.000Z' }),
    person({ id: '3', displayName: 'No Joining Date', joiningDate: null }),
  ];

  it('includes both ends of the range', () => {
    const chosen = state({ ranges: { joined: { from: '2024-04-10', to: '2024-06-30' } } });
    expect(names(applyRosterFilters(roster, chosen))).toEqual(['Joined April', 'Joined June']);
  });

  it('takes one half on its own', () => {
    expect(names(applyRosterFilters(roster, state({ ranges: { joined: { from: '2024-05-01' } } }))))
      .toEqual(['Joined June']);
    expect(names(applyRosterFilters(roster, state({ ranges: { joined: { to: '2024-05-01' } } }))))
      .toEqual(['Joined April']);
  });

  it('leaves out the people carrying no date at all, rather than quietly widening the answer', () => {
    const chosen = state({ ranges: { joined: { from: '2000-01-01' } } });
    expect(names(applyRosterFilters(roster, chosen))).not.toContain('No Joining Date');
  });

  it('reads a resignation and a termination as one leaving date', () => {
    const leavers = [
      person({ id: '1', displayName: 'Resigned', exitDate: '2025-02-02T00:00:00.000Z' }),
      person({ id: '2', displayName: 'Dismissed', terminationDate: '2025-02-03T00:00:00.000Z' }),
      person({ id: '3', displayName: 'Still Here' }),
    ];
    const chosen = state({ ranges: { left: { from: '2025-01-01', to: '2025-12-31' } } });
    expect(names(applyRosterFilters(leavers, chosen))).toEqual(['Resigned', 'Dismissed']);
  });
});

describe('how much of a home the stored pin is', () => {
  it('grades the four cases the planning screen actually cares about', () => {
    expect(pinQuality(person({ geoSource: 'manual', geoAccuracyMeters: 10 }))).toBe('exact');
    expect(pinQuality(person({ geoSource: 'osm_locality', geoAccuracyMeters: 9000 }))).toBe('area');
    expect(pinQuality(person({ geoSource: null, geoAccuracyMeters: null }))).toBe('area');
    // 100 km is the geocoder's own way of saying it could not find the address.
    expect(pinQuality(person({ geoSource: 'locality', geoAccuracyMeters: 100_000 }))).toBe('placeholder');
    expect(pinQuality(person({ latitude: null, longitude: null }))).toBe('none');
  });
});

describe('the documents filter', () => {
  const tally = { required: 12, withScan: 3, verified: 2, awaitingVerdict: 1 };

  it('hides itself when the server sent no paperwork tally', () => {
    // Without this an absent key reads as zero and every person lands in "nothing uploaded".
    const withoutTally = [person({ id: '1' })];
    expect(availableFilters(withoutTally).some((f) => f.key === 'documents')).toBe(false);
    expect(availableFilters([person({ id: '1', documents: tally })]).some((f) => f.key === 'documents')).toBe(true);
  });

  it('separates a scan waiting for a verdict from a person who has uploaded nothing', () => {
    const roster = [
      person({ id: '1', displayName: 'Waiting', documents: tally }),
      person({ id: '2', displayName: 'Nothing', documents: { required: 12, withScan: 0, verified: 0, awaitingVerdict: 0 } }),
    ];
    expect(names(applyRosterFilters(roster, state({ choices: { documents: ['awaiting'] } })))).toEqual(['Waiting']);
    expect(names(applyRosterFilters(roster, state({ choices: { documents: ['nothing'] } })))).toEqual(['Nothing']);
  });

  it('counts each option against the roster in front of the reader', () => {
    const roster = [
      person({ id: '1', documents: tally }),
      person({ id: '2', documents: { required: 12, withScan: 0, verified: 12, awaitingVerdict: 0 } }),
    ];
    const counts = Object.fromEntries(ruleChoices(ruleDef('documents'), roster).map((c) => [c.value, c.count]));
    expect(counts.awaiting).toBe(1);
    expect(counts.complete).toBe(1);
  });
});

describe('showing and undoing what is applied', () => {
  it('names each criterion in the words of the control that set it', () => {
    const chosen = state({
      segment: 'unpayable',
      search: 'kochi',
      choices: { state: ['Kerala'], record: ['unpayable'] },
      ranges: { joined: { from: '2024-01-01', to: '2024-12-31' } },
    });
    expect(describeFilters(chosen).map((p) => p.label)).toEqual([
      'Cannot be paid',
      'Search "kochi"',
      'State they live in: Kerala',
      'Record completeness: Cannot be paid yet',
      'Joined between 2024-01-01 to 2024-12-31',
    ]);
  });

  it('takes off one value without touching the others on the same axis', () => {
    const chosen = state({ choices: { state: ['Kerala', 'Goa'] } });
    expect(clearFilter(chosen, 'state', 'Kerala').choices.state).toEqual(['Goa']);
  });

  it('never adds a value back — a clear that could add is the opposite of its name', () => {
    const chosen = state({ choices: { state: ['Goa'] } });
    expect(clearFilter(chosen, 'state', 'Kerala').choices.state).toEqual(['Goa']);
    // Whereas ticking is a toggle, which is what a tick box is.
    expect(toggleChoice(chosen, 'state', 'Kerala').choices.state).toEqual(['Goa', 'Kerala']);
  });

  it('drops the whole axis when no value is named, and the segment with its own pill', () => {
    const chosen = state({ segment: 'exited', choices: { state: ['Kerala', 'Goa'] } });
    expect(clearFilter(chosen, 'state').choices.state).toBeUndefined();
    expect(clearFilter(chosen, 'segment').segment).toBe('all');
  });
});

describe('the query string', () => {
  it('survives being pasted to a colleague: every axis, both ends of a range, the search', () => {
    const chosen = state({
      segment: 'unpayable',
      search: 'kochi',
      choices: { state: ['Kerala', 'Goa'], record: ['unpayable'] },
      ranges: { joined: { from: '2024-01-01', to: '2024-12-31' } },
    });
    const written = writeFilters(new URLSearchParams(), chosen);
    expect(parseFilters(written)).toEqual(chosen);
  });

  it('leaves the params this screen does not own alone', () => {
    // `?assayer=` and `?register=` are in bookmarks and notification payloads; a filter change
    // that dropped them would break an interrupted registration.
    const existing = new URLSearchParams('register=abc&view=3');
    const written = writeFilters(existing, state({ choices: { state: ['Kerala'] } }));
    expect(written.get('register')).toBe('abc');
    expect(written.get('view')).toBe('3');
    expect(written.getAll('f_state')).toEqual(['Kerala']);
  });

  it('clears its own params when the filters are cleared', () => {
    const written = writeFilters(new URLSearchParams('f_state=Kerala&segment=exited&q=x'), EMPTY_FILTERS);
    expect(written.toString()).toBe('');
  });

  it('shows everybody rather than an empty page when a link names a segment that has gone', () => {
    expect(parseFilters(new URLSearchParams('segment=no-such-queue')).segment).toBe('all');
  });
});

describe('the catalogue itself', () => {
  it('gives every filter and every option a key of its own', () => {
    const keys = ROSTER_FILTERS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of ROSTER_FILTERS) {
      if (def.kind !== 'rule') continue;
      const values = def.choices.map((c) => c.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('offers far more than the three axes this screen used to have', () => {
    // The point of the file: nineteen questions, from a screen that could ask three.
    expect(ROSTER_FILTERS.length).toBeGreaterThanOrEqual(19);
  });

  it('never shows a stored code where a person reads', () => {
    const roster = [person({ engagementType: 'BACK_UP', employmentType: 'FULL_TIME', unavailableReason: 'NO_WORK_IN_AREA' })];
    for (const def of ROSTER_FILTERS) {
      const options = def.kind === 'field'
        ? fieldChoices(def, roster)
        : def.kind === 'rule' ? ruleChoices(def, roster) : [];
      for (const o of options) expect(o.label).not.toMatch(/^[A-Z][A-Z_]+$/);
    }
  });
});

/**
 * The live roster's shape, at the live roster's size.
 *
 * 1,163 people, 548 of them ACTIVE. Filtering happens in the browser on every keystroke and
 * every tick, over all of them, for each of nineteen axes plus a facet count per axis — so the
 * counts have to be right at that size and the work has to stay bounded.
 */
describe('at the size of the real roster', () => {
  const roster: RosterPerson[] = Array.from({ length: 1163 }, (_, i) => person({
    id: `a-${i}`,
    assayerCode: `AS${String(i).padStart(4, '0')}`,
    displayName: `Person ${i}`,
    lifecycleStatus: i < 548 ? AssayerLifecycleStatus.ACTIVE : AssayerLifecycleStatus.INACTIVE,
    state: i % 3 === 0 ? 'Kerala' : 'Karnataka',
    // 245 of the active ones cannot be paid — the shape of the live data, where a green ACTIVE
    // stage says nothing about whether a payout would land.
    bankAccountNumber: i < 245 ? null : '000111222333',
  }));

  it('counts the populations the chips claim', () => {
    const active = ROSTER_SEGMENTS.find((s) => s.key === 'active')!;
    expect(roster.filter(active.match).length).toBe(548);
    expect(names(applyRosterFilters(roster, state({ segment: 'unpayable' }))).length).toBe(245);
  });

  it('cuts 548 active people down to the Kerala ones who cannot be paid', () => {
    const chosen = state({
      choices: { stage: [AssayerLifecycleStatus.ACTIVE], state: ['Kerala'], record: ['unpayable'] },
    });
    const got = applyRosterFilters(roster, chosen);
    expect(got.length).toBe(roster.filter(
      (p) => p.lifecycleStatus === AssayerLifecycleStatus.ACTIVE && p.state === 'Kerala' && !p.bankAccountNumber,
    ).length);
    expect(got.length).toBeGreaterThan(0);
  });

  it('builds every option list and every facet count for the whole roster in one pass', () => {
    const chosen = state({ choices: { state: ['Kerala'] } });
    const started = Date.now();
    for (const def of availableFilters(roster)) {
      const scope = applyRosterFilters(roster, chosen, ROSTER_FILTERS, def.key);
      if (def.kind === 'field') fieldChoices(def, scope);
      if (def.kind === 'rule') ruleChoices(def, scope);
    }
    // Not a benchmark — a guard against an accidental per-row `find` turning the panel into a
    // several-second freeze on the roster it is meant for.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
