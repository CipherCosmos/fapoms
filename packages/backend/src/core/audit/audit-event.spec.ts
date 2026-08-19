import { AuditEvent, NOT_A_RECORD_ENTITY_ID } from './audit-event';
import { EventCategory } from '@fapoms/shared';

const base = {
  category: EventCategory.WORKFLOW,
  eventType: 'PROJECT_COMPLETED',
  entityType: 'PROJECT',
  entityId: '11111111-1111-4111-8111-111111111111',
};

describe('AuditEvent', () => {
  describe('the actor', () => {
    it('keeps a uuid actor as the actor', () => {
      const actor = '22222222-2222-4222-8222-222222222222';
      const event = AuditEvent.record({ ...base, userId: actor });

      expect(event.userId).toBe(actor);
      expect(event.metadata).toBeNull();
    });

    it('refuses a non-uuid actor rather than letting the insert throw', () => {
      // `user_id` is a uuid column. Passing 'system' would fail the INSERT, and a failed
      // insert means the trail entry is lost — the one failure an audit system must not have.
      const event = AuditEvent.record({ ...base, userId: 'system' });

      expect(event.userId).toBeNull();
    });

    it('preserves a refused actor instead of discarding it', () => {
      // Previously the value was dropped outright, so an event recorded against 'system' or an
      // employee code read back identically to one with no actor at all — with nothing to
      // indicate that identifying information had been removed.
      const event = AuditEvent.record({ ...base, userId: 'ASSAYER-4471' });

      expect(event.userId).toBeNull();
      expect(event.metadata).toEqual({ unresolvedActor: 'ASSAYER-4471' });
    });

    it('preserves a refused actor alongside metadata the caller supplied', () => {
      const event = AuditEvent.record({
        ...base,
        userId: 'system',
        metadata: { reason: 'nightly sweep' },
      });

      expect(event.metadata).toEqual({ reason: 'nightly sweep', unresolvedActor: 'system' });
    });

    it('treats a missing actor as no actor, with nothing to preserve', () => {
      const event = AuditEvent.record({ ...base });

      expect(event.userId).toBeNull();
      expect(event.metadata).toBeNull();
    });

    it('treats an empty-string actor as no actor rather than as a refused one', () => {
      const event = AuditEvent.record({ ...base, userId: '' });

      expect(event.userId).toBeNull();
      // An empty string carries no information, so recording it under `unresolvedActor` would
      // be noise that looks like evidence.
      expect(event.metadata).toBeNull();
    });

    it('accepts an uppercase uuid', () => {
      const actor = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
      expect(AuditEvent.record({ ...base, userId: actor }).userId).toBe(actor);
    });
  });

  describe('the subject', () => {
    it('keeps a uuid entity id as the subject', () => {
      const event = AuditEvent.record({ ...base });

      expect(event.entityId).toBe(base.entityId);
      expect(event.metadata).toBeNull();
    });

    it('refuses a non-uuid entity id rather than letting the insert throw', () => {
      // `entity_id` is `uuid NOT NULL`. This is the bug that made the whole class of it
      // visible: the platform-settings controller passed a setting key here, Postgres
      // rejected every insert, and the caller swallowed the error — so no settings change
      // was ever audited and the trail's emptiness was the only symptom.
      const event = AuditEvent.record({ ...base, entityId: 'email.transport' });

      expect(event.entityId).toBe(NOT_A_RECORD_ENTITY_ID);
      expect(event.metadata).toEqual({ unresolvedEntityId: 'email.transport' });
    });

    it('treats a missing entity id as no record, with nothing to preserve', () => {
      const event = AuditEvent.record({ ...base, entityId: null as any });

      expect(event.entityId).toBe(NOT_A_RECORD_ENTITY_ID);
      expect(event.metadata).toBeNull();
    });

    it('leaves the sentinel alone when a caller passes it deliberately', () => {
      // A caller with no record to name is expected to say so outright. Annotating that as
      // unresolved would turn the intended value into evidence of a mistake.
      const event = AuditEvent.record({ ...base, entityId: NOT_A_RECORD_ENTITY_ID });

      expect(event.entityId).toBe(NOT_A_RECORD_ENTITY_ID);
      expect(event.metadata).toBeNull();
    });

    it('preserves a refused subject alongside a refused actor and caller metadata', () => {
      const event = AuditEvent.record({
        ...base,
        entityId: 'ALL',
        userId: 'system',
        metadata: { reason: 'nightly sweep' },
      });

      expect(event.entityId).toBe(NOT_A_RECORD_ENTITY_ID);
      expect(event.userId).toBeNull();
      expect(event.metadata).toEqual({
        reason: 'nightly sweep',
        unresolvedActor: 'system',
        unresolvedEntityId: 'ALL',
      });
    });
  });

  describe('optional fields', () => {
    it('normalises every absent optional to null', () => {
      const event = AuditEvent.record({ ...base });

      // The columns are nullable, and `undefined` would make TypeORM omit them from the
      // INSERT rather than write NULL — a difference that shows up on read as a missing key.
      expect(event.previousState).toBeNull();
      expect(event.newState).toBeNull();
      expect(event.userDisplayName).toBeNull();
      expect(event.ipAddress).toBeNull();
      expect(event.remarks).toBeNull();
    });

    it('carries the supplied values through unchanged', () => {
      const event = AuditEvent.record({
        ...base,
        previousState: 'IN_PROGRESS',
        newState: 'COMPLETED',
        userDisplayName: 'A. Auditor',
        ipAddress: '10.0.0.4',
        remarks: 'closed after final review',
      });

      expect(event.previousState).toBe('IN_PROGRESS');
      expect(event.newState).toBe('COMPLETED');
      expect(event.userDisplayName).toBe('A. Auditor');
      expect(event.ipAddress).toBe('10.0.0.4');
      expect(event.remarks).toBe('closed after final review');
    });
  });

  describe('immutability', () => {
    it('cannot be altered after construction', () => {
      const event = AuditEvent.record({ ...base, newState: 'COMPLETED' });

      // The trail is append-only. An entry that can be edited between construction and insert
      // is an entry that does not necessarily describe what happened.
      expect(() => {
        (event as unknown as { newState: string }).newState = 'CANCELLED';
      }).toThrow();
      expect(event.newState).toBe('COMPLETED');
    });

    it.each([
      ['a refused actor is recorded alongside it', 'system', { unresolvedActor: 'system' }],
      ['the actor is a uuid and nothing is added', '22222222-2222-4222-8222-222222222222', {}],
    ])('does not alias the caller\'s metadata object when %s', (_case, userId, extra) => {
      const supplied = { reason: 'nightly sweep' };
      const event = AuditEvent.record({ ...base, userId, metadata: supplied });

      supplied.reason = 'mutated afterwards';

      expect(event.metadata).toEqual({ reason: 'nightly sweep', ...extra });
    });
  });
});
