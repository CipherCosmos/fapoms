/**
 * Turns the permission model into language an administrator can act on.
 *
 * The stored model is `resource × action × scope` — 67 rows across 22 resources, written in
 * enum case. Rendered raw it reads like a database dump: `ASSIGNMENT | VIEW | ASSIGNED_RECORDS`
 * tells an operations manager nothing about whether someone can see other people's work. This
 * maps the model onto how the business actually talks about itself.
 *
 * Three deliberate choices:
 *
 * 1. **Group by area, not by resource.** 22 resource headings is a wall; six areas mirror the
 *    sidebar, so "where would I look for this?" has the same answer in both places.
 * 2. **Hide the scope that is always the same.** 50-odd of the 67 rows are ORGANIZATION, so
 *    printing it against each one is pure noise. Only the *restrictive* scopes — the ones
 *    meaning "their own records only" — change a decision, so only those are shown.
 * 3. **Keep unknown values visible.** Anything not mapped falls back to a de-cased version of
 *    the raw value rather than being dropped, so a permission added later still appears.
 */

export interface AreaSpec {
  key: string;
  label: string;
  hint: string;
  resources: string[];
}

/** Mirrors the sidebar's grouping so the two read the same way. */
export const PERMISSION_AREAS: AreaSpec[] = [
  {
    key: 'operations',
    label: 'Operations',
    hint: 'Projects, planning, assignments and the branch book',
    resources: ['PROJECT', 'PLANNING', 'ASSIGNMENT', 'SCHEDULING', 'BRANCH', 'ZONE'],
  },
  {
    key: 'field',
    label: 'Field & Documents',
    hint: 'The assayer workforce and audit paperwork',
    resources: ['ASSAYER', 'DOCUMENT', 'OCR'],
  },
  {
    key: 'validation',
    label: 'Validation & Data Entry',
    hint: 'Checking returned audits and raising clarifications',
    resources: ['VALIDATION', 'AUDIT'],
  },
  {
    key: 'money',
    label: 'Billing & Payments',
    hint: 'Invoices, payables and expense decisions',
    resources: ['BILLING'],
  },
  {
    key: 'clients',
    label: 'Clients',
    hint: 'Client records, contracts and correspondence',
    resources: ['CLIENT', 'ORGANIZATION', 'COMMUNICATION'],
  },
  {
    key: 'admin',
    label: 'Administration',
    hint: 'Staff accounts, system settings and the audit trail',
    resources: ['USER', 'CONFIGURATION', 'HOLIDAY', 'AUDIT_LOG'],
  },
];

const RESOURCE_LABELS: Record<string, string> = {
  PROJECT: 'Projects',
  PLANNING: 'Planning',
  ASSIGNMENT: 'Assignments',
  SCHEDULING: 'Scheduling',
  BRANCH: 'Branches',
  ZONE: 'Territorial zones',
  ASSAYER: 'Assayers',
  DOCUMENT: 'Documents',
  OCR: 'Document scanning',
  VALIDATION: 'Validation',
  AUDIT: 'Audit records',
  BILLING: 'Billing',
  CLIENT: 'Clients',
  ORGANIZATION: 'Organisations',
  COMMUNICATION: 'Communications',
  USER: 'Staff accounts',
  CONFIGURATION: 'System settings',
  HOLIDAY: 'Holiday calendar',
  AUDIT_LOG: 'Audit trail',
};

const ACTION_LABELS: Record<string, string> = {
  VIEW: 'View',
  CREATE: 'Create',
  EDIT: 'Edit',
  DELETE: 'Delete',
  APPROVE: 'Approve',
  CANCEL: 'Cancel',
  EXPORT: 'Export',
  IMPORT: 'Import',
  ARCHIVE: 'Archive',
  CLOSE: 'Close',
  ASSIGN: 'Assign',
  REVIEW: 'Review',
  NEGOTIATE: 'Negotiate fees',
  ACCEPT: 'Accept',
  GENERATE: 'Generate',
  UPLOAD: 'Upload',
  DOWNLOAD: 'Download',
  MODIFY: 'Reschedule',
};

/**
 * Scopes worth showing. ORGANIZATION and PLATFORM are the ordinary "across the business" case
 * and appear on almost every row, so surfacing them would add weight without informing anyone.
 * These two genuinely narrow what a person can reach, so they are called out.
 */
const RESTRICTIVE_SCOPES: Record<string, string> = {
  SELF: 'own only',
  ASSIGNED_RECORDS: 'assigned only',
};

const deCase = (v: string): string =>
  v.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());

export const resourceLabel = (resource: string): string =>
  RESOURCE_LABELS[resource] ?? deCase(resource);

export const actionLabel = (action: string): string => ACTION_LABELS[action] ?? deCase(action);

/** The qualifier to show beside an action, or null when the scope is the ordinary one. */
export const scopeQualifier = (scope: string): string | null => RESTRICTIVE_SCOPES[scope] ?? null;

/** Area a resource belongs to; anything unmapped collects under Administration. */
export function areaForResource(resource: string): string {
  const found = PERMISSION_AREAS.find((a) => a.resources.includes(resource));
  return found ? found.key : 'admin';
}
