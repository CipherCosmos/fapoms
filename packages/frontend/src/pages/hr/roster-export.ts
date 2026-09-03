import { assayerLifecycleLabel, employmentTypeLabel } from '@fapoms/shared';

import type { CsvCell } from '../../utils/csv';
import {
  ENGAGEMENT_LABELS, UNAVAILABLE_LABELS, PIN_QUALITY_LABELS, pinQuality,
  missingFields, payoutBlockers, tenureMonths,
  type RosterPerson,
} from './roster-filters';

/**
 * What a roster export can contain, and what it must never pretend to contain.
 *
 * The screen had two exports and neither could be chosen: a fixed eleven-column CSV of whatever
 * was on screen, and a server-built workbook of the whole roster. "Export what we need" is the
 * ask, and this is the list of what there is to need — one entry per column, so adding a column
 * later is data rather than another `cols` array somewhere.
 *
 * THE MASKED THREE. `panNumber`, `aadhaarNumber` and `bankAccountNumber` arrive from the API
 * already covered — the last four characters and bullets for the rest — because a logged-in
 * session used to be able to pull 1,163 people's KYC identifiers in one request. A column of
 * `••••234F` in a spreadsheet is worse than no column: it looks like data, it will be pasted
 * into a bank portal, and the first person to notice will be the one whose payment failed. So
 * the three exist here with the truth in their heading — "PAN (last 4 only)" — and they are in
 * no preset. Beside each sits the column that answers the question people actually export these
 * for: whether the record has one at all.
 *
 * This is not a way around the reveal endpoint. The values are masked before they reach the
 * browser, so no export from this screen can contain a whole number; the full value comes from
 * `GET /assayers/:id/sensitive/:field`, one person at a time, and that request is recorded.
 */
export interface RosterExportColumn {
  key: string;
  /** The heading in the file. It has to be true on its own, away from this screen. */
  label: string;
  group: string;
  value: (a: RosterPerson) => CsvCell;
  /** Masked in transit: the file gets the last four characters, never the number. */
  masked?: boolean;
  /**
   * The record property behind it, when that property is one the API strips by role.
   * A column whose source is absent from every row is not empty — it is invisible to this
   * account — and the picker says so instead of exporting a column of blanks.
   */
  source?: string;
}

const YES_NO = (value: boolean): string => (value ? 'Yes' : 'No');

/** Present, and not blank. `undefined` (the field was stripped) is not the same as empty. */
const onFile = (value: unknown): string => YES_NO(value != null && String(value).trim() !== '');

/** ISO day, because a spreadsheet sorts `2024-04-01` and cannot sort `01 Apr 2024`. */
const isoDay = (value?: string | null): string => {
  if (!value) return '';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '' : at.toISOString().slice(0, 10);
};

const list = (values?: string[] | null): string => (values ?? []).filter(Boolean).join('; ');

export const ROSTER_EXPORT_COLUMNS: RosterExportColumn[] = [
  // ── Who they are ───────────────────────────────────────────────────────────────────────
  { key: 'assayerCode', label: 'Assayer code', group: 'Who they are', value: (a) => a.assayerCode },
  { key: 'displayName', label: 'Name', group: 'Who they are', value: (a) => a.displayName },
  { key: 'firstName', label: 'First name', group: 'Who they are', value: (a) => a.firstName },
  { key: 'lastName', label: 'Last name', group: 'Who they are', value: (a) => a.lastName },
  { key: 'employeeId', label: 'Employee ID', group: 'Who they are', value: (a) => a.employeeId },
  { key: 'vstsCode', label: 'VSTS code', group: 'Who they are', value: (a) => a.vstsCode ?? '' },
  { key: 'dateOfBirth', label: 'Date of birth', group: 'Who they are', source: 'dateOfBirth', value: (a) => isoDay(a.dateOfBirth) },
  { key: 'qualification', label: 'Qualification', group: 'Who they are', value: (a) => a.qualification ?? '' },
  { key: 'languages', label: 'Languages', group: 'Who they are', value: (a) => list(a.languages) },

  // ── How to reach them ──────────────────────────────────────────────────────────────────
  { key: 'phone', label: 'Phone', group: 'How to reach them', value: (a) => a.phone },
  { key: 'alternatePhone', label: 'Alternate phone', group: 'How to reach them', value: (a) => a.alternatePhone ?? '' },
  { key: 'email', label: 'Email', group: 'How to reach them', value: (a) => a.email ?? '' },
  {
    key: 'emergencyContactName',
    label: 'Emergency contact',
    group: 'How to reach them',
    source: 'emergencyContactName',
    value: (a) => a.emergencyContactName ?? '',
  },
  {
    key: 'emergencyContactPhone',
    label: 'Emergency contact phone',
    group: 'How to reach them',
    source: 'emergencyContactPhone',
    value: (a) => a.emergencyContactPhone ?? '',
  },
  {
    key: 'emergencyContactRelation',
    label: 'Emergency contact relation',
    group: 'How to reach them',
    source: 'emergencyContactRelation',
    value: (a) => a.emergencyContactRelation ?? '',
  },

  // ── Where they are ─────────────────────────────────────────────────────────────────────
  { key: 'address', label: 'Address', group: 'Where they are', value: (a) => a.address },
  { key: 'city', label: 'City or town', group: 'Where they are', value: (a) => a.city },
  { key: 'district', label: 'District', group: 'Where they are', value: (a) => a.district },
  { key: 'state', label: 'State', group: 'Where they are', value: (a) => a.state },
  { key: 'pincode', label: 'Pincode', group: 'Where they are', value: (a) => a.pincode ?? '' },
  { key: 'region', label: 'Region', group: 'Where they are', value: (a) => a.region ?? '' },
  { key: 'latitude', label: 'Latitude', group: 'Where they are', value: (a) => a.latitude },
  { key: 'longitude', label: 'Longitude', group: 'Where they are', value: (a) => a.longitude },
  {
    key: 'pinQuality',
    // The words the screen uses, not the geocoder's ("osm_locality", "±900 m"): a coordinate
    // that is a state centre has to look untrustworthy in the file as well as on the page.
    label: 'How good the home pin is',
    group: 'Where they are',
    value: (a) => PIN_QUALITY_LABELS[pinQuality(a)],
  },

  // ── Their work with us ─────────────────────────────────────────────────────────────────
  { key: 'lifecycleStatus', label: 'Stage with HR', group: 'Their work with us', value: (a) => assayerLifecycleLabel(a.lifecycleStatus) },
  {
    key: 'engagementType',
    label: 'How they are engaged',
    group: 'Their work with us',
    value: (a) => (a.engagementType ? ENGAGEMENT_LABELS[a.engagementType] ?? a.engagementType : ''),
  },
  { key: 'employmentType', label: 'Employment type', group: 'Their work with us', value: (a) => (a.employmentType ? employmentTypeLabel(a.employmentType) : '') },
  {
    key: 'unavailableReason',
    label: 'Why they are unavailable',
    group: 'Their work with us',
    value: (a) => (a.unavailableReason ? UNAVAILABLE_LABELS[a.unavailableReason] ?? a.unavailableReason : ''),
  },
  { key: 'department', label: 'Department', group: 'Their work with us', value: (a) => a.department ?? '' },
  { key: 'hrOwnerName', label: 'HR owner', group: 'Their work with us', value: (a) => a.hrOwnerName ?? '' },
  { key: 'joiningDate', label: 'Joining date', group: 'Their work with us', value: (a) => isoDay(a.joiningDate) },
  { key: 'tenureMonths', label: 'Months with us', group: 'Their work with us', value: (a) => tenureMonths(a) },
  { key: 'exitDate', label: 'Resignation date', group: 'Their work with us', value: (a) => isoDay(a.exitDate) },
  { key: 'terminationDate', label: 'Termination date', group: 'Their work with us', value: (a) => isoDay(a.terminationDate) },
  { key: 'experienceYears', label: 'Years of experience', group: 'Their work with us', value: (a) => a.experienceYears ?? 0 },
  { key: 'skills', label: 'Skills', group: 'Their work with us', value: (a) => list(a.skills) },
  { key: 'specializations', label: 'Specialisations', group: 'Their work with us', value: (a) => list(a.specializations) },
  { key: 'preferredRegions', label: 'Preferred regions', group: 'Their work with us', value: (a) => list(a.preferredRegions) },
  { key: 'maxDailyWorkload', label: 'Max audits per day', group: 'Their work with us', value: (a) => a.maxDailyWorkload },
  { key: 'maxWeeklyWorkload', label: 'Max audits per week', group: 'Their work with us', value: (a) => a.maxWeeklyWorkload },
  { key: 'performanceRating', label: 'Performance rating', group: 'Their work with us', value: (a) => a.performanceRating },
  {
    key: 'workDoneBySomeoneElse',
    label: 'Audit attended by somebody else',
    group: 'Their work with us',
    value: (a) => YES_NO(a.workDoneBySomeoneElse === true),
  },

  // ── Paperwork and money ────────────────────────────────────────────────────────────────
  { key: 'bankName', label: 'Bank', group: 'Paperwork and money', source: 'bankName', value: (a) => a.bankName ?? '' },
  { key: 'ifscCode', label: 'IFSC', group: 'Paperwork and money', source: 'ifscCode', value: (a) => a.ifscCode ?? '' },
  { key: 'panOnFile', label: 'PAN on file', group: 'Paperwork and money', source: 'panNumber', value: (a) => onFile(a.panNumber) },
  { key: 'aadhaarOnFile', label: 'Aadhaar on file', group: 'Paperwork and money', source: 'aadhaarNumber', value: (a) => onFile(a.aadhaarNumber) },
  {
    key: 'bankAccountOnFile',
    label: 'Bank account on file',
    group: 'Paperwork and money',
    source: 'bankAccountNumber',
    value: (a) => onFile(a.bankAccountNumber),
  },
  {
    key: 'panNumber',
    label: 'PAN (last 4 only — not the full number)',
    group: 'Paperwork and money',
    masked: true,
    source: 'panNumber',
    value: (a) => a.panNumber ?? '',
  },
  {
    key: 'aadhaarNumber',
    label: 'Aadhaar (last 4 only — not the full number)',
    group: 'Paperwork and money',
    masked: true,
    source: 'aadhaarNumber',
    value: (a) => a.aadhaarNumber ?? '',
  },
  {
    key: 'bankAccountNumber',
    label: 'Bank account (last 4 only — not the full number)',
    group: 'Paperwork and money',
    masked: true,
    source: 'bankAccountNumber',
    value: (a) => a.bankAccountNumber ?? '',
  },
  { key: 'certifications', label: 'Certificates', group: 'Paperwork and money', value: (a) => (a.certifications ?? []).map((c) => (c.expiryDate ? `${c.name} (to ${isoDay(c.expiryDate)})` : c.name)).join('; ') },
  { key: 'documentsLink', label: 'Documents folder', group: 'Paperwork and money', value: (a) => a.documentsLink ?? '' },

  // ── Is the record usable ───────────────────────────────────────────────────────────────
  {
    key: 'missingFields',
    label: 'Missing from the record',
    group: 'Is the record usable',
    value: (a) => missingFields(a).join('; '),
  },
  {
    key: 'canBePaid',
    // The consequence, not the three column names. This is the column the payout run needs.
    label: 'Can be paid',
    group: 'Is the record usable',
    value: (a) => YES_NO(payoutBlockers(a).length === 0),
  },
  {
    key: 'documentsWithScan',
    label: 'Documents with a scan attached',
    group: 'Is the record usable',
    value: (a) => a.documents?.withScan ?? '',
  },
  {
    key: 'documentsVerified',
    label: 'Documents verified',
    group: 'Is the record usable',
    value: (a) => a.documents?.verified ?? '',
  },
  {
    key: 'documentsAwaiting',
    label: 'Documents waiting for a verdict',
    group: 'Is the record usable',
    value: (a) => a.documents?.awaitingVerdict ?? '',
  },
  {
    key: 'documentsRequired',
    label: 'Documents required',
    group: 'Is the record usable',
    value: (a) => a.documents?.required ?? '',
  },
];

export const EXPORT_COLUMN_GROUPS: string[] = [
  ...new Set(ROSTER_EXPORT_COLUMNS.map((c) => c.group)),
];

/**
 * The three or four exports people actually run, as one click each.
 *
 * A column picker with fifty tick boxes and no starting point is a worse experience than the two
 * fixed buttons it replaces. Each preset is a job somebody has: ring these people, chase these
 * records, get payroll ready. Every one of them is then editable — the preset is a starting
 * point, not a menu.
 */
export const EXPORT_PRESETS: { key: string; label: string; hint: string; columns: string[] }[] = [
  {
    key: 'contact',
    label: 'Contact list',
    hint: 'Names, numbers and where they live.',
    columns: ['assayerCode', 'displayName', 'phone', 'alternatePhone', 'email', 'city', 'district', 'state', 'lifecycleStatus'],
  },
  {
    key: 'chase',
    label: 'What needs chasing',
    hint: 'Who to ring, and what is missing from their file.',
    columns: [
      'assayerCode', 'displayName', 'phone', 'lifecycleStatus', 'missingFields', 'canBePaid',
      'documentsAwaiting', 'documentsWithScan', 'certifications', 'pinQuality',
    ],
  },
  {
    key: 'payroll',
    label: 'Payroll readiness',
    hint: 'Whether each person can be paid, without a single identifier in the file.',
    columns: [
      'assayerCode', 'displayName', 'lifecycleStatus', 'employmentType', 'engagementType',
      'joiningDate', 'bankName', 'ifscCode', 'panOnFile', 'bankAccountOnFile', 'canBePaid',
    ],
  },
  {
    key: 'planning',
    label: 'Coverage and skills',
    hint: 'What each person can do and how far their pin can be trusted.',
    columns: [
      'assayerCode', 'displayName', 'state', 'district', 'city', 'region', 'pinQuality',
      'skills', 'languages', 'experienceYears', 'maxDailyWorkload', 'lifecycleStatus',
    ],
  },
  {
    key: 'everything',
    label: 'Everything except identifiers',
    hint: 'Every column above, leaving out the three that are only ever masked.',
    columns: ROSTER_EXPORT_COLUMNS.filter((c) => !c.masked).map((c) => c.key),
  },
];

export const columnByKey = (key: string): RosterExportColumn | undefined =>
  ROSTER_EXPORT_COLUMNS.find((c) => c.key === key);

/**
 * The columns this account cannot fill.
 *
 * The API strips identity, banking and staff-private fields for roles that may not read them —
 * `scopeAssayerForRoles` deletes the property rather than blanking it. So an absent key across
 * every row means "you are not allowed to see this", which is a different thing from "nobody has
 * one", and a spreadsheet cannot tell the two apart. The picker greys these out and says why.
 */
export function restrictedColumns(rows: RosterPerson[], columns = ROSTER_EXPORT_COLUMNS): Set<string> {
  const out = new Set<string>();
  if (rows.length === 0) return out;
  for (const col of columns) {
    if (!col.source) continue;
    if (rows.every((r) => !(col.source! in r))) out.add(col.key);
  }
  return out;
}

/** Header row and cells for the chosen columns, in the order the picker lists them. */
export function buildRosterExport(
  rows: RosterPerson[],
  columnKeys: string[],
): { headers: string[]; cells: CsvCell[][] } {
  const chosen = ROSTER_EXPORT_COLUMNS.filter((c) => columnKeys.includes(c.key));
  return {
    headers: chosen.map((c) => c.label),
    cells: rows.map((r) => chosen.map((c) => c.value(r))),
  };
}
