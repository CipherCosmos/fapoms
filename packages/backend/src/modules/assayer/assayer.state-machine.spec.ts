import { AssayerStateMachine } from './assayer.state-machine';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus } from '@fapoms/shared';
import { BadRequestException } from '@nestjs/common';

describe('AssayerStateMachine', () => {
  let assayer: AssayerEntity;

  beforeEach(() => {
    assayer = {
      id: 'asr-1',
      lifecycleStatus: AssayerLifecycleStatus.INVITED,
      status: 'INACTIVE',
      isActive: true,
    } as AssayerEntity;
  });

  it('should transition from INVITED to DOCUMENT_VERIFICATION', () => {
    const event = AssayerStateMachine.verifyDocuments(assayer, 'user-1');
    expect(assayer.lifecycleStatus).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
    expect(event.previousState).toBe(AssayerLifecycleStatus.INVITED);
    expect(event.newState).toBe(AssayerLifecycleStatus.DOCUMENT_VERIFICATION);
  });

  it('should throw BadRequestException on invalid transition', () => {
    expect(() => {
      AssayerStateMachine.activate(assayer, 'user-1');
    }).toThrow(BadRequestException);
  });

  /**
   * The rehire edge (2026-09-07): RESIGNED/TERMINATED → INVITED, added to the shared lifecycle
   * map (`@fapoms/shared/assayer-lifecycle.ts`) so someone who left can genuinely come back. See
   * `AssayerStateMachine.rehire`'s own comment for why it targets INVITED — restarting onboarding
   * — rather than snapping back to ACTIVE, and why it returns a plain `DomainEvent`.
   */
  describe('rehire — RESIGNED/TERMINATED → INVITED', () => {
    const resigned = () => ({
      id: 'asr-1', lifecycleStatus: AssayerLifecycleStatus.RESIGNED, status: 'INACTIVE', isActive: true,
    } as AssayerEntity);
    const terminated = () => ({
      id: 'asr-2', lifecycleStatus: AssayerLifecycleStatus.TERMINATED, status: 'INACTIVE', isActive: true,
    } as AssayerEntity);

    it('moves a resigned assayer back to INVITED', () => {
      const a = resigned();
      const event = AssayerStateMachine.rehire(a, 'user-1');

      expect(a.lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
      expect(event.previousState).toBe(AssayerLifecycleStatus.RESIGNED);
      expect(event.newState).toBe(AssayerLifecycleStatus.INVITED);
    });

    it('moves a terminated assayer back to INVITED', () => {
      const a = terminated();
      AssayerStateMachine.rehire(a, 'user-1');

      expect(a.lifecycleStatus).toBe(AssayerLifecycleStatus.INVITED);
    });

    it('refuses a rehire from a state that never left — ACTIVE has no edge to INVITED', () => {
      const a = {
        id: 'asr-3', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, status: 'ACTIVE', isActive: true,
      } as AssayerEntity;

      expect(() => AssayerStateMachine.rehire(a, 'user-1')).toThrow(BadRequestException);
    });

    it('sets the operational status the same way onboarding always has — INACTIVE, not ACTIVE', () => {
      const a = resigned();
      AssayerStateMachine.rehire(a, 'user-1');

      expect(a.status).toBe('INACTIVE');
    });

    /**
     * Same contract as every other move on this class: status changes, dates do not.
     * `AssayerService.reconcileDepartureDates` is the single writer for `exitDate`/
     * `terminationDate` on a rehire exactly as on every departure — see "recording the day
     * someone left is not this machine's job" below, which pins that division for the outbound
     * moves this one mirrors.
     */
    it("does not touch exit/termination dates — clearing them is the service's job, not this machine's", () => {
      const a = { ...resigned(), exitDate: new Date('2024-01-01'), terminationDate: null } as any;

      AssayerStateMachine.rehire(a, 'user-1');

      expect(a.exitDate).toEqual(new Date('2024-01-01'));
      expect(a.terminationDate).toBeNull();
    });
  });
  /**
   * Departure was recorded only in `lifecycleStatus`, while every count and filter of departures
   * reads `exitDate`/`terminationDate` — which nothing set. The roster's "Exited" chip and the
   * workforce header's "0 exited" therefore stayed at zero however many people left, and someone
   * plainly shown as RESIGNED was counted in neither Active nor Exited.
   */
  /**
   * The operational status is what planning filters on. Leave has to reach it, or the two ways
   * of saying "away" — the HR lifecycle and the dated leave rows — disagree, and the planner
   * respects only the second.
   */
  describe('leave reaches the status planning reads', () => {
    const active = () => ({
      id: 'asr-1',
      lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
      status: 'ACTIVE',
      isActive: true,
    } as AssayerEntity);

    it('stops offering work to someone put on leave', () => {
      const a = active();
      AssayerStateMachine.putOnLeave(a, 'user-1');

      expect(a.lifecycleStatus).toBe(AssayerLifecycleStatus.ON_LEAVE);
      // Was ACTIVE: on-leave assayers stayed in the candidate pool and in daily capacity.
      expect(a.status).toBe('INACTIVE');
    });

    it('puts them back in the pool when they return', () => {
      const a = active();
      AssayerStateMachine.putOnLeave(a, 'user-1');
      AssayerStateMachine.activate(a, 'user-1');

      expect(a.lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);
      expect(a.status).toBe('ACTIVE');
    });

    it('keeps suspension distinct from leave', () => {
      const a = active();
      AssayerStateMachine.suspend(a, 'user-1');
      expect(a.status).toBe('SUSPENDED');
    });
  });

  /**
   * The state machine deliberately does NOT stamp departure dates.
   *
   * It used to, and the behaviour tests for that stamping lived here — they have moved to
   * `assayer.service.spec.ts` ("a departure the rest of the system can see"), because the single
   * writer is now the service's `reconcileDepartureDates`. Two writers for one column meant the
   * machine filled `exitDate` before the service could, so the service's impossible-pair guard
   * never ran and its audit remark never named the stamp. What this suite still owns is the
   * machine's contract: status changes only, dates untouched.
   */
  describe("recording the day someone left is not this machine's job", () => {
    const activeAssayer = () => ({ lifecycleStatus: 'ACTIVE', isActive: true }) as any;

    it('accepts a resignation without touching the dates', () => {
      const a = activeAssayer();

      AssayerStateMachine.acceptResignation(a, 'user-1');

      expect(a.lifecycleStatus).toBe('RESIGNED');
      expect(a.exitDate).toBeUndefined();
      expect(a.terminationDate).toBeUndefined();
    });

    it('terminates without touching the dates', () => {
      const a = { lifecycleStatus: 'SUSPENDED', isActive: true } as any;

      AssayerStateMachine.terminate(a, 'user-1');

      expect(a.lifecycleStatus).toBe('TERMINATED');
      expect(a.terminationDate).toBeUndefined();
    });

    it('leaves the dates alone for a move that is not a departure', () => {
      const a = activeAssayer();

      AssayerStateMachine.putOnLeave(a, 'user-1');

      expect(a.exitDate).toBeUndefined();
      expect(a.terminationDate).toBeUndefined();
    });
  });
  /**
   * A plain shortest-path search routed a new joiner to ACTIVE via
   * INVITED → DOCUMENT_VERIFICATION → INACTIVE → ACTIVE, because that is three hops where the
   * real onboarding chain is four. Selecting a batch of new joiners and moving them to ACTIVE
   * therefore skipped background verification and training altogether — marking people
   * field-ready who had passed neither — and left a record saying they had been deactivated and
   * reinstated, which never happened.
   */
  describe('findPathTo — outcome states are destinations, not waypoints', () => {
    it('onboards through the real chain rather than cutting through INACTIVE', () => {
      expect(AssayerStateMachine.findPathTo('INVITED', 'ACTIVE')).toEqual([
        'DOCUMENT_VERIFICATION',
        'BACKGROUND_VERIFICATION',
        'TRAINING',
        'ACTIVE',
      ]);
    });

    it('still reaches an outcome state when that is where you asked to go', () => {
      expect(AssayerStateMachine.findPathTo('DOCUMENT_VERIFICATION', 'INACTIVE')).toEqual(['INACTIVE']);
    });

    /**
     * On the way out, an outcome state is the designed route rather than a shortcut: closing a
     * trainee's file really does pass through INACTIVE, and nothing is skipped by taking it.
     */
    it('still closes a trainee file through INACTIVE, because that is the real route out', () => {
      expect(AssayerStateMachine.findPathTo('TRAINING', 'ARCHIVED')).toEqual(['INACTIVE', 'ARCHIVED']);
    });

    it('returns an empty path when already there', () => {
      expect(AssayerStateMachine.findPathTo('ACTIVE', 'ACTIVE')).toEqual([]);
    });

    it('reaches the rehire edge directly — RESIGNED and TERMINATED both lead straight to INVITED', () => {
      expect(AssayerStateMachine.findPathTo('RESIGNED', 'INVITED')).toEqual(['INVITED']);
      expect(AssayerStateMachine.findPathTo('TERMINATED', 'INVITED')).toEqual(['INVITED']);
    });
  });
});
