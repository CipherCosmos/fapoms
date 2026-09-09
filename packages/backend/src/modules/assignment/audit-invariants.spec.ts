import { AssignmentStatus } from '@fapoms/shared';
import {
  assertAuditMatchesPersistedState,
  assertNothingRecorded,
  AuditInvariantViolation,
} from './audit-invariants';

/**
 * The invariant itself, and then the seven assignment scenarios measured against it.
 *
 * The first half proves the assertion has teeth — an assertion that passes everything is worse
 * than none, because it makes the scenarios below look checked. Each case here is a defect that
 * actually reached production or was one edit away from it.
 */
describe('audit invariants', () => {
  const ASSIGNMENT = 'a1000000-0000-4000-a000-000000000001';
  const OLD = 'aa000000-0000-4000-a000-00000000000a';
  const NEW = 'bb000000-0000-4000-b000-00000000000b';

  const persisted = (over: Partial<{ assayerId: string; status: string; entityVersion: number }> = {}) => ({
    id: ASSIGNMENT,
    assayerId: over.assayerId ?? NEW,
    status: (over.status ?? AssignmentStatus.PENDING) as AssignmentStatus,
    entityVersion: over.entityVersion ?? 2,
  });

  const goodAudit = () => ([{
    eventType: 'ASSIGNMENT_REASSIGNED',
    entityId: ASSIGNMENT,
    newState: AssignmentStatus.PENDING as string,
    previousState: AssignmentStatus.PENDING as string,
    metadata: { previousAssayerId: OLD, newAssayerId: NEW, entityVersion: 2 },
  }]);

  describe('the assertion has teeth', () => {
    it('passes when the response, the row, the audit and the lineage all agree', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'reassign happy path',
        apiResponse: { id: ASSIGNMENT, assayerId: NEW, status: AssignmentStatus.PENDING, entityVersion: 2 },
        persisted: persisted(),
        auditRows: goodAudit(),
        lineageRows: [{ previousAssayerId: OLD, newAssayerId: NEW }],
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).not.toThrow();
    });

    /** Exactly the shape of the live defect: response says one thing, the row says another. */
    it('catches an API response that disagrees with the row about the assayer', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'silent revert',
        apiResponse: { id: ASSIGNMENT, assayerId: NEW, status: AssignmentStatus.PENDING, entityVersion: 2 },
        persisted: persisted({ assayerId: OLD }),
        auditRows: goodAudit(),
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).toThrow(AuditInvariantViolation);
    });

    it('catches an audit row built from the request rather than the saved row', () => {
      let err: any;
      try {
        assertAuditMatchesPersistedState({
          scenario: 'audit from intent',
          apiResponse: { id: ASSIGNMENT, assayerId: OLD, status: AssignmentStatus.PENDING, entityVersion: 2 },
          persisted: persisted({ assayerId: OLD }),
          // The row never moved, but the audit says it did.
          auditRows: goodAudit(),
          expectedEventType: 'ASSIGNMENT_REASSIGNED',
        });
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(AuditInvariantViolation);
      expect(err.problems.join(' ')).toMatch(/metadata\.newAssayerId/);
    });

    it('catches a missing audit row on a successful command', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'no audit',
        apiResponse: { id: ASSIGNMENT, assayerId: NEW },
        persisted: persisted(),
        auditRows: [],
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).toThrow(/no ASSIGNMENT_REASSIGNED audit row/);
    });

    it('catches a duplicated audit row — one command, one event', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'double audit',
        apiResponse: { id: ASSIGNMENT, assayerId: NEW },
        persisted: persisted(),
        auditRows: [...goodAudit(), ...goodAudit()],
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).toThrow(/2 ASSIGNMENT_REASSIGNED audit rows/);
    });

    it('catches a version the audit disagrees with', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'version drift',
        apiResponse: { id: ASSIGNMENT, assayerId: NEW, entityVersion: 2 },
        persisted: persisted({ entityVersion: 3 }),
        auditRows: goodAudit(),
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).toThrow(AuditInvariantViolation);
    });

    it('catches lineage that records a move the row does not show', () => {
      expect(() => assertAuditMatchesPersistedState({
        scenario: 'lineage drift',
        apiResponse: { id: ASSIGNMENT, assayerId: OLD },
        persisted: persisted({ assayerId: OLD }),
        auditRows: [{ ...goodAudit()[0], metadata: { newAssayerId: OLD, entityVersion: 2 } }],
        lineageRows: [{ previousAssayerId: OLD, newAssayerId: NEW }],
        expectedEventType: 'ASSIGNMENT_REASSIGNED',
      })).toThrow(/lineage records a move to/);
    });

    it('reports every disagreement at once rather than only the first', () => {
      let err: any;
      try {
        assertAuditMatchesPersistedState({
          scenario: 'everything wrong',
          apiResponse: { id: ASSIGNMENT, assayerId: NEW, status: AssignmentStatus.ACCEPTED, entityVersion: 9 },
          persisted: persisted({ assayerId: OLD, status: AssignmentStatus.PENDING, entityVersion: 2 }),
          auditRows: goodAudit(),
          expectedEventType: 'ASSIGNMENT_REASSIGNED',
        });
      } catch (e) { err = e; }
      expect(err.problems.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('a refused command records nothing', () => {
    const before = persisted({ assayerId: OLD, status: AssignmentStatus.CANCELLED, entityVersion: 4 });

    it('passes when the row is untouched and nothing was written', () => {
      expect(() => assertNothingRecorded({
        scenario: 'reassign a cancelled assignment',
        before, after: { ...before },
        auditRowsWritten: 0, lineageRowsWritten: 0,
      })).not.toThrow();
    });

    it('catches an audit row written for a command that was refused', () => {
      expect(() => assertNothingRecorded({
        scenario: 'refused but audited',
        before, after: { ...before },
        auditRowsWritten: 1, lineageRowsWritten: 0,
      })).toThrow(/1 audit rows written for a refused command/);
    });

    it('catches a lineage row written for a command that was refused', () => {
      expect(() => assertNothingRecorded({
        scenario: 'refused but lineage written',
        before, after: { ...before },
        auditRowsWritten: 0, lineageRowsWritten: 1,
      })).toThrow(/1 lineage rows written for a refused command/);
    });

    /** A version that moved on a refused command means the write happened and rolled back badly. */
    it('catches a version that advanced despite the refusal', () => {
      expect(() => assertNothingRecorded({
        scenario: 'partial rollback',
        before, after: { ...before, entityVersion: 5 },
        auditRowsWritten: 0, lineageRowsWritten: 0,
      })).toThrow(/version moved 4 → 5/);
    });

    it('catches a status that changed despite the refusal', () => {
      expect(() => assertNothingRecorded({
        scenario: 'silent revival',
        before, after: { ...before, status: AssignmentStatus.PENDING },
        auditRowsWritten: 0, lineageRowsWritten: 0,
      })).toThrow(/status moved CANCELLED → PENDING/);
    });
  });

  /**
   * The seven assignment commands that write history, each measured by the same assertion.
   *
   * Every case is built from a persisted row and an audit event that must describe it. Before the
   * extraction, each of these had its own inline expectations in its own file, which is how one
   * of them came to be verified against the request instead of the row for months.
   */
  describe('the seven scenarios', () => {
    const scenarios: Array<{ name: string; eventType: string; status: AssignmentStatus }> = [
      { name: 'create',      eventType: 'ASSIGNMENT_CREATED',    status: AssignmentStatus.PENDING },
      { name: 'reassign',    eventType: 'ASSIGNMENT_REASSIGNED', status: AssignmentStatus.PENDING },
      { name: 'accept',      eventType: 'ASSIGNMENT_ACCEPTED',   status: AssignmentStatus.ACCEPTED },
      { name: 'reject',      eventType: 'ASSIGNMENT_REJECTED',   status: AssignmentStatus.REJECTED },
      { name: 'check in',    eventType: 'ASSIGNMENT_CHECKED_IN', status: AssignmentStatus.CHECKED_IN },
      { name: 'start work',  eventType: 'ASSIGNMENT_STARTED',    status: AssignmentStatus.IN_PROGRESS },
      { name: 'complete',    eventType: 'ASSIGNMENT_COMPLETED',  status: AssignmentStatus.COMPLETED },
    ];

    it.each(scenarios)('$name: a truthful record passes', ({ eventType, status }) => {
      const row = persisted({ status, entityVersion: 5 });
      expect(() => assertAuditMatchesPersistedState({
        scenario: eventType,
        apiResponse: { id: row.id, assayerId: row.assayerId, status, entityVersion: 5 },
        persisted: row,
        auditRows: [{ eventType, entityId: row.id, newState: status, metadata: { entityVersion: 5 } }],
        expectedEventType: eventType,
      })).not.toThrow();
    });

    it.each(scenarios)('$name: an audit event naming the wrong state is caught', ({ eventType, status }) => {
      const row = persisted({ status, entityVersion: 5 });
      const wrongState = status === AssignmentStatus.COMPLETED
        ? AssignmentStatus.ACCEPTED : AssignmentStatus.COMPLETED;
      expect(() => assertAuditMatchesPersistedState({
        scenario: eventType,
        apiResponse: { id: row.id, assayerId: row.assayerId, status, entityVersion: 5 },
        persisted: row,
        auditRows: [{ eventType, entityId: row.id, newState: wrongState, metadata: { entityVersion: 5 } }],
        expectedEventType: eventType,
      })).toThrow(AuditInvariantViolation);
    });

    it.each(scenarios)('$name: an audit event attached to a different assignment is caught', ({ eventType, status }) => {
      const row = persisted({ status });
      expect(() => assertAuditMatchesPersistedState({
        scenario: eventType,
        apiResponse: { id: row.id, assayerId: row.assayerId, status },
        persisted: row,
        auditRows: [{ eventType, entityId: 'ffffffff-0000-4000-f000-00000000000f', newState: status }],
        expectedEventType: eventType,
      })).toThrow(/audit row points at/);
    });
  });
});
