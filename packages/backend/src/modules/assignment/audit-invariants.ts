import { AssignmentStatus } from '@fapoms/shared';

/**
 * One statement of what a truthful audit trail means, so seven scenarios cannot each decide.
 *
 * The reassignment defect was not that the audit row was missing. It was written, on time, with
 * a confident and completely wrong assayer id — built from the caller's request rather than from
 * the row that had just been saved, so it described what was asked for instead of what happened.
 * Every scenario that writes an audit row can make that mistake, and each one had its own ad-hoc
 * assertions in tests, which is why only one of them was caught.
 *
 * `assertAuditMatchesPersistedState` is the single assertion. Give it what the API returned, what
 * the database holds, and the audit row, and it insists all three agree. Give it a failed command
 * and it insists nothing was recorded at all — a rejected operation that still leaves an audit
 * event is the same defect wearing the opposite sign.
 */

/** The shape of a persisted assignment as read back from the row, however it was read. */
export interface PersistedAssignmentState {
  id: string;
  assayerId: string;
  status: AssignmentStatus | string;
  entityVersion: number;
}

/** The audit row as stored, in the two shapes callers hold it. */
export interface AuditRecord {
  eventType: string;
  entityId: string;
  newState?: string | null;
  previousState?: string | null;
  metadata?: Record<string, any> | null;
}

export interface AuditInvariantInput {
  scenario: string;
  /** What the API answered the caller. */
  apiResponse: { id: string; assayerId?: string; status?: string; entityVersion?: number };
  /** What the database holds now. Read back, never the in-memory entity. */
  persisted: PersistedAssignmentState;
  /** Every audit row written for this operation. */
  auditRows: AuditRecord[];
  /** Lineage rows written for this operation, where the scenario writes any. */
  lineageRows?: Array<{ previousAssayerId?: string | null; newAssayerId?: string | null }>;
  /** The event type that must be present exactly once. */
  expectedEventType: string;
}

/** Thrown with every disagreement listed, so one run tells you everything that is wrong. */
export class AuditInvariantViolation extends Error {
  constructor(scenario: string, public readonly problems: string[]) {
    super(`Audit invariants violated for "${scenario}":\n  - ${problems.join('\n  - ')}`);
    this.name = 'AuditInvariantViolation';
  }
}

/**
 * A successful command: the response, the row, the audit event and the lineage must all agree.
 *
 * "Agree" is deliberately strict about identity and version. Those are the fields that were wrong
 * while everything else looked right, and they are the fields somebody reading the trail months
 * later has no way to check.
 */
export function assertAuditMatchesPersistedState(input: AuditInvariantInput): void {
  const problems: string[] = [];
  const { apiResponse, persisted, auditRows, lineageRows, expectedEventType } = input;

  if (apiResponse.id !== persisted.id) {
    problems.push(`API answered id ${apiResponse.id}, row is ${persisted.id}`);
  }
  if (apiResponse.assayerId !== undefined && apiResponse.assayerId !== persisted.assayerId) {
    problems.push(
      `API answered assayerId ${apiResponse.assayerId}, row holds ${persisted.assayerId} `
      + '(this is exactly the reassignment defect)',
    );
  }
  if (apiResponse.status !== undefined && apiResponse.status !== persisted.status) {
    problems.push(`API answered status ${apiResponse.status}, row holds ${persisted.status}`);
  }
  if (apiResponse.entityVersion !== undefined && Number(apiResponse.entityVersion) !== Number(persisted.entityVersion)) {
    problems.push(`API answered version ${apiResponse.entityVersion}, row is at ${persisted.entityVersion}`);
  }

  const matching = auditRows.filter((r) => r.eventType === expectedEventType);
  if (matching.length === 0) {
    problems.push(`no ${expectedEventType} audit row was written for a successful command`);
  } else if (matching.length > 1) {
    problems.push(`${matching.length} ${expectedEventType} audit rows written for one command`);
  }

  for (const row of matching) {
    if (row.entityId !== persisted.id) {
      problems.push(`audit row points at ${row.entityId}, operation was on ${persisted.id}`);
    }
    if (row.newState != null && row.newState !== persisted.status) {
      problems.push(`audit newState ${row.newState} disagrees with the row's ${persisted.status}`);
    }
    const auditedAssayer = row.metadata?.newAssayerId;
    if (auditedAssayer != null && auditedAssayer !== persisted.assayerId) {
      problems.push(
        `audit metadata.newAssayerId ${auditedAssayer} disagrees with the row's ${persisted.assayerId}`,
      );
    }
    const auditedVersion = row.metadata?.entityVersion;
    if (auditedVersion != null && Number(auditedVersion) !== Number(persisted.entityVersion)) {
      problems.push(`audit metadata.entityVersion ${auditedVersion} disagrees with the row's ${persisted.entityVersion}`);
    }
  }

  if (lineageRows?.length) {
    const open = lineageRows.filter((l) => l.newAssayerId != null);
    for (const l of open) {
      if (l.newAssayerId !== persisted.assayerId) {
        problems.push(`lineage records a move to ${l.newAssayerId}, row holds ${persisted.assayerId}`);
      }
    }
  }

  if (problems.length) throw new AuditInvariantViolation(input.scenario, problems);
}

/**
 * A refused command: the row is untouched and NOTHING was recorded.
 *
 * The mirror-image invariant, and the one the reassignment fix turns on. A rejected operation
 * that still writes lineage or an audit event produces a history of things that did not happen,
 * which is worse than a history with gaps because it is trusted.
 */
export function assertNothingRecorded(input: {
  scenario: string;
  before: PersistedAssignmentState;
  after: PersistedAssignmentState;
  auditRowsWritten: number;
  lineageRowsWritten: number;
}): void {
  const problems: string[] = [];
  if (input.before.assayerId !== input.after.assayerId) {
    problems.push(`assayer moved ${input.before.assayerId} → ${input.after.assayerId} on a refused command`);
  }
  if (input.before.status !== input.after.status) {
    problems.push(`status moved ${input.before.status} → ${input.after.status} on a refused command`);
  }
  if (Number(input.before.entityVersion) !== Number(input.after.entityVersion)) {
    problems.push(
      `version moved ${input.before.entityVersion} → ${input.after.entityVersion} on a refused command `
      + '(the write happened and was rolled back incompletely)',
    );
  }
  if (input.auditRowsWritten !== 0) {
    problems.push(`${input.auditRowsWritten} audit rows written for a refused command`);
  }
  if (input.lineageRowsWritten !== 0) {
    problems.push(`${input.lineageRowsWritten} lineage rows written for a refused command`);
  }
  if (problems.length) throw new AuditInvariantViolation(input.scenario, problems);
}
