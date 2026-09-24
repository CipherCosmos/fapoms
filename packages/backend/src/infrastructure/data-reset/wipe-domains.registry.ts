/**
 * Every business-data domain a super administrator may clear, declared in one place —
 * `settings.registry.ts`'s style, for the same reason: what a destructive admin action touches
 * should be a reviewable declaration, not something read off the entity folder by whoever last
 * remembers to update it.
 *
 * Deliberately absent: `roles`, `permissions`, `capabilities`, `responsibilities`, `organizations`,
 * `platform_settings`. These are structural — the shape of the RBAC/tenant model, not test data —
 * and clearing them can strip role assignments from every *kept* user, which can lock everyone,
 * including the admin who just ran the wipe, out of the app. A "reset RBAC too" capability, if
 * ever wanted, should be its own rarer and more deliberate feature.
 */

export interface WipeDomain {
  key: string;
  label: string;
  description: string;
  /** This domain's own tables. The FK graph (see fk-graph.service.ts) decides the real order and
   *  catches anything this list forgets — this is documentation, not the execution plan. */
  tables: string[];
  /** Only `users`: the admin must pick which accounts survive before this can run. */
  requiresKeepList?: true;
  /** Only `billing`: these FKs are ON DELETE RESTRICT by design — a second confirmation matches
   *  the extra weight the schema itself already gives this data. */
  requiresBillingConfirmation?: true;
}

/**
 * Tables this feature will never truncate or delete from, under any selection. `audit_events` is
 * documented elsewhere in this codebase as append-only ("must NEVER have UPDATE or DELETE") — this
 * tool does not become the exception. `workflow_history` and `outbox_events` are the operational
 * and event-delivery record, same reasoning `RetentionService` already applies to what it will
 * never purge.
 *
 * Note: `ocr_jobs` rows for a deleted document will still empty out as a side effect of the
 * `projects` domain wiping `documents` (that FK cascades) — an orphaned OCR job for a document
 * that no longer exists isn't worth protecting, and this list is about tables the wipe reaches
 * *directly*, not every downstream cascade.
 */
// `destructive_action_requests`: the approval trail must survive the wipe it approved — a wipe
// that could erase the record of who authorised it would defeat the two-person rule outright.
export const NEVER_WIPEABLE_TABLES = ['audit_events', 'workflow_history', 'outbox_events', 'destructive_action_requests'] as const;

export const WIPE_DOMAINS: WipeDomain[] = [
  {
    key: 'users',
    label: 'User accounts',
    description: 'Every account except the ones you choose to keep. Roles and permissions themselves are never touched. A removed account\'s notifications go with it automatically (a real ON DELETE CASCADE); select "Notifications" too to also clear assayers\' notifications.',
    requiresKeepList: true,
    // `notifications` is deliberately absent: it has a real FK (`user_id … ON DELETE CASCADE`) so
    // deleting a user already takes their notifications with it — no manual table needed, and the
    // live FK graph will surface it as an implied domain if that matters to what's selected.
    // `device_tokens`/`refresh_tokens`/`notification_preferences` have no such constraint (verified
    // against the schema), so they need to be listed and scoped explicitly — see
    // `USER_SCOPED_TABLES` in data-reset.service.ts.
    // `user_sessions`, `user_mfa`, `mfa_recovery_codes` and `activity_telemetry` carry a `user_id`
    // but no FK, so nothing cascades them: a removed account's sessions, MFA secrets and recovery
    // codes outlived it. Scoped like the tokens — see `USER_SCOPED_TABLES`.
    tables: [
      'device_tokens', 'refresh_tokens', 'user_sessions', 'user_mfa', 'mfa_recovery_codes',
      'activity_telemetry', 'users',
    ],
  },
  {
    key: 'clients',
    label: 'Clients & contracts',
    description: 'Client master records, contacts, contracts and their billing profile.',
    tables: ['client_billing', 'client_contracts', 'client_contacts', 'client_configurations', 'clients'],
  },
  {
    key: 'branches',
    label: 'Branches',
    description: 'Branch master records, their contacts and documents.',
    tables: ['branch_documents', 'branch_contacts', 'branches'],
  },
  {
    key: 'assayers',
    label: 'Assayer workforce & hiring',
    description: 'Assayer profiles, commercial terms, documents and activity history — and the hiring pipeline behind them: interviews, applications and their uploaded papers.',
    // The hiring tables have no FK to `assayers` (a candidate exists before any assayer does), so
    // nothing cascaded them: wiping the workforce left the whole hiring page standing, full of
    // candidates "promoted" into assayers that no longer existed. Listed here, not as their own
    // domain, for exactly that reason — the two only make sense together.
    tables: [
      'assayer_location_pings', 'assayer_activities', 'assayer_remarks', 'workforce_attributes',
      'assayer_commercial_profiles', 'assayer_documents',
      'assayer_application_documents', 'assayer_applications', 'assayer_interviews',
      'assayers',
    ],
  },
  {
    key: 'projects',
    label: 'Projects, branches & assessments',
    description: 'Projects, the branches assigned to them, assessments, customer-master imports and documents.',
    tables: [
      'coverage_plan_versions', 'coverage_plans', 'customer_records', 'customer_master_versions',
      'documents', 'assessments', 'project_branches', 'projects',
    ],
  },
  {
    key: 'assignments',
    label: 'Assignments & fieldwork',
    description: 'Assignments, schedules, call logs, expenses and field execution records.',
    tables: [
      'assignment_comments',
      'assignment_expenses', 'schedules', 'call_logs', 'assignments',
    ],
  },
  {
    key: 'validation',
    label: 'Validation queue',
    description: 'Validation cases and the query threads raised against them.',
    tables: ['validation_query_messages', 'validation_queries', 'validation_cases'],
  },
  {
    key: 'billing',
    label: 'Billing & payments',
    description: 'Invoices, payments, payables and billing history. These records are protected by the database itself (ON DELETE RESTRICT) — clearing this data needs its own confirmation below.',
    requiresBillingConfirmation: true,
    // `assayer_invoices` (the assayer's monthly bill) has no FK to anything here, so it used to
    // survive a billing wipe untouched.
    tables: [
      'billing_payments', 'billing_history', 'assayer_payables', 'billing_entries', 'billing_invoices',
      'assayer_invoices',
    ],
  },
  {
    // User-facing label is "Support requests" (the channel renamed from "Feedback" to
    // "Support"); key and tables keep the historical 'feedback' name.
    key: 'feedback',
    label: 'Support requests',
    description: 'Support/bug/idea threads, their messages and votes.',
    tables: ['feedback_votes', 'feedback_messages', 'feedback_threads'],
  },
  {
    key: 'notifications',
    label: 'Notifications',
    description: 'In-app notifications for every recipient (not tied to which users you keep).',
    tables: ['notifications', 'notification_preferences'],
  },
  {
    key: 'referenceMisc',
    label: 'Zones, holidays & transport rates',
    description: 'Operational reference data: zone boundaries, the holiday calendar and the transport rate card.',
    tables: ['zones', 'holidays', 'transport_rates'],
  },
  {
    key: 'businessRules',
    label: 'Business rules & bypass windows',
    description: 'Configured business rules and any open rule-bypass windows.',
    tables: ['rule_bypass_windows', 'business_rules'],
  },
  {
    key: 'geo',
    label: 'Geography reference data',
    description: 'States, districts and cities. Rarely needed — most deployments keep one geography loaded.',
    tables: ['geo_cities', 'geo_districts', 'geo_states'],
  },
];

/**
 * Every other table, and why a wipe leaves it alone.
 *
 * This exists because `WIPE_DOMAINS` is a list, and a list only covers the tables that existed the
 * day it was written. The hiring pipeline, the assayer invoices and the session/MFA tables were all
 * added later, were never listed, and so silently survived every "clear everything". The spec
 * beside this file now requires every entity table to be in a domain, in `NEVER_WIPEABLE_TABLES`,
 * or here with a reason — a new table cannot be forgotten again without failing the build.
 */
export const NOT_WIPED_TABLES: Record<string, string> = {
  // Structure, not data (see the header of this file).
  roles: 'RBAC structure', permissions: 'RBAC structure', capabilities: 'RBAC structure',
  responsibilities: 'RBAC structure', role_permissions: 'RBAC structure',
  role_responsibilities: 'RBAC structure', capability_permissions: 'RBAC structure',
  responsibility_capabilities: 'RBAC structure', organizations: 'tenant structure',
  platform_settings: 'runtime configuration', notification_settings: 'notification catalog configuration',
  // Removed by the database with their parent rows (ON DELETE CASCADE), scoped correctly.
  user_roles: 'cascades from users — only removed accounts lose their roles',
  assayer_background_checks: 'cascades from assayers', assayer_references: 'cascades from assayers',
  assayer_onboarding_approvals: 'cascades from assayers', assayer_document_versions: 'cascades from assayers',
  assayer_idempotency_records: 'cascades from assayers', assayer_import_issues: 'cascades from assayers',
  assayer_client_empanelments: 'cascades from assayers and from clients',
  assayer_score_overrides: 'cascades from assayers and from clients',
  assignment_idempotency_records: 'cascades from assignments',
  assignment_reassignments: 'cascades from assignments',
  ocr_jobs: 'cascades from documents',
  // Records the law or the audit trail requires to outlive a data reset.
  audit_chain: 'audit trail hash chain — same reasoning as audit_events',
  security_incidents: 'statutory DPDP breach record',
  data_rights_requests: 'statutory DPDP data-principal request record',
  outbound_messages: 'email/SMS delivery record — same reasoning as outbox_events',
  // Self-expiring: retention removes a finished job (and its uploaded file and report) after 30 days,
  // and an open one is somebody's upload in progress — deleting its row mid-run would leave a worker
  // writing progress onto nothing. A wipe does not delete stored files either, so clearing these
  // rows would only orphan the uploads they point at.
  background_jobs: 'self-expiring upload/job record (30 days); retention deletes it with its files',
};

export function findDomain(key: string): WipeDomain | undefined {
  return WIPE_DOMAINS.find((d) => d.key === key);
}

/** Every table any domain owns, keyed back to its domain — used to map an FK-graph-impacted table back to "which domain does the admin need to also select". */
export function tableToDomain(): Map<string, string> {
  const map = new Map<string, string>();
  for (const domain of WIPE_DOMAINS) {
    for (const table of domain.tables) map.set(table, domain.key);
  }
  return map;
}
