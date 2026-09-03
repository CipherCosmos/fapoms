import { AssayerLifecycleStatus } from '@fapoms/shared';

import {
  ROSTER_EXPORT_COLUMNS, EXPORT_PRESETS, buildRosterExport, restrictedColumns, columnByKey,
} from './roster-export';
import type { RosterPerson } from './roster-filters';
import { toCsv } from '../../utils/csv';

/**
 * The export, held to the one promise that matters most.
 *
 * A masked identifier in a spreadsheet is worse than an absent one: `••••234F` looks like data,
 * and the first person to find out otherwise is whoever pasted it into a bank portal. So the
 * three masked columns must carry the truth in their heading, must be in no preset, and must
 * never be what a clerk reaches for when the question is "does this person have a PAN".
 */

const person = (over: Partial<RosterPerson>): RosterPerson => ({
  id: 'a-1',
  assayerCode: 'AS0001',
  employeeId: 'E1',
  employeeCode: null,
  firstName: 'Asha',
  lastName: 'Nair',
  displayName: 'Asha Nair',
  email: 'asha@example.com',
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
  panNumber: '••••234F',
  bankAccountNumber: '••••2333',
  ifscCode: 'HDFC0000001',
  notes: null,
  employmentType: 'INTERNAL',
  joiningDate: '2024-04-01T00:00:00.000Z',
  exitDate: null,
  terminationDate: null,
  managerId: null,
  department: null,
  region: 'South',
  emergencyContactName: null,
  emergencyContactPhone: '+919000000001',
  emergencyContactRelation: null,
  photograph: null,
  skills: ['Gold', 'Diamond'],
  certifications: null,
  languages: null,
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

describe('the three identifiers that are only ever masked', () => {
  const masked = ROSTER_EXPORT_COLUMNS.filter((c) => c.masked).map((c) => c.key);

  it('covers exactly the fields the API masks in transit', () => {
    expect(masked.sort()).toEqual(['aadhaarNumber', 'bankAccountNumber', 'panNumber']);
  });

  it('says so in the heading, which is the only thing that travels with the file', () => {
    for (const key of masked) {
      expect(columnByKey(key)!.label).toMatch(/last 4 only — not the full number/);
    }
  });

  it('is in none of the presets, including the one called "everything"', () => {
    for (const preset of EXPORT_PRESETS) {
      expect(preset.columns.filter((k) => masked.includes(k))).toEqual([]);
    }
  });

  it('answers the real question with a yes/no column instead', () => {
    const [row] = buildRosterExport(
      [person({ panNumber: '••••234F', aadhaarNumber: null, bankAccountNumber: '••••2333' })],
      ['panOnFile', 'aadhaarOnFile', 'bankAccountOnFile'],
    ).cells;
    // A masked value still means the record HAS one — that is what the column is for.
    expect(row).toEqual(['Yes', 'No', 'Yes']);
  });
});

describe('columns this account may not read', () => {
  it('are told apart from columns nobody has filled', () => {
    // `scopeAssayerForRoles` DELETES a field the role may not see, so an absent key means
    // "not allowed" while null means "empty" — and a spreadsheet cannot tell the two apart.
    const stripped = person({});
    delete (stripped as Partial<RosterPerson>).panNumber;
    delete (stripped as Partial<RosterPerson>).bankAccountNumber;

    const blocked = restrictedColumns([stripped]);
    expect(blocked.has('panOnFile')).toBe(true);
    expect(blocked.has('bankAccountNumber')).toBe(true);
    // Present but empty is not restricted: the clerk may read it, there is simply nothing there.
    expect(restrictedColumns([person({ panNumber: null })]).has('panOnFile')).toBe(false);
  });

  it('says nothing at all about an empty roster, rather than blaming the reader', () => {
    expect(restrictedColumns([]).size).toBe(0);
  });
});

describe('the file itself', () => {
  const asha = person({});

  it('orders columns by the catalogue, however they were ticked', () => {
    const { headers } = buildRosterExport([asha], ['state', 'assayerCode', 'displayName']);
    expect(headers).toEqual(['Assayer code', 'Name', 'State']);
  });

  it('writes dates a spreadsheet can sort', () => {
    const { cells } = buildRosterExport([asha], ['joiningDate']);
    expect(cells[0][0]).toBe('2024-04-01');
  });

  it('writes plain English where the record holds a code', () => {
    const { cells } = buildRosterExport(
      [person({ lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION, engagementType: 'BACK_UP', employmentType: 'INTERNAL' })],
      ['lifecycleStatus', 'engagementType', 'employmentType'],
    );
    expect(cells[0]).toEqual(['Background Verification', 'Back-up', 'On our payroll']);
  });

  it('carries the same verdict on a home pin that the filter uses', () => {
    const centroid = person({ geoSource: 'locality', geoAccuracyMeters: 500_000 });
    const { cells } = buildRosterExport([centroid], ['pinQuality']);
    expect(cells[0][0]).toBe('A state or district centre, not a home');
  });

  it('names what is missing, and whether that stops a payment', () => {
    const { cells } = buildRosterExport(
      [person({ bankAccountNumber: null, ifscCode: null })],
      ['missingFields', 'canBePaid'],
    );
    expect(cells[0][0]).toBe('Bank account; IFSC');
    expect(cells[0][1]).toBe('No');
  });

  it('leaves the paperwork tally blank when the server did not send one', () => {
    const { cells } = buildRosterExport([asha], ['documentsAwaiting']);
    // Not 0 — nobody has said there are none, and a zero in a chase list is an instruction.
    expect(cells[0][0]).toBe('');
  });

  it('survives a name with a comma, because the escaping is not written here', () => {
    const { headers, cells } = buildRosterExport(
      [person({ displayName: 'Nair, Asha' })],
      ['displayName', 'skills'],
    );
    expect(toCsv(headers, cells)).toContain('"Nair, Asha","Gold; Diamond"');
  });
});

describe('the presets', () => {
  it('name columns that exist', () => {
    for (const preset of EXPORT_PRESETS) {
      for (const key of preset.columns) expect(columnByKey(key)).toBeDefined();
    }
  });

  it('offer far more than the eleven fixed columns the old CSV had', () => {
    expect(ROSTER_EXPORT_COLUMNS.length).toBeGreaterThanOrEqual(40);
  });
});
