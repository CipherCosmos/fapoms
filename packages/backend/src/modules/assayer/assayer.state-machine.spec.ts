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
   * Departure was recorded only in `lifecycleStatus`, while every count and filter of departures
   * reads `exitDate`/`terminationDate` — which nothing set. The roster's "Exited" chip and the
   * workforce header's "0 exited" therefore stayed at zero however many people left, and someone
   * plainly shown as RESIGNED was counted in neither Active nor Exited.
   */
  describe('recording the day someone left', () => {
    const activeAssayer = () => ({ lifecycleStatus: 'ACTIVE', isActive: true }) as any;

    it('stamps an exit date when a resignation is accepted', () => {
      const a = activeAssayer();

      AssayerStateMachine.acceptResignation(a, 'user-1');

      expect(a.lifecycleStatus).toBe('RESIGNED');
      expect(a.exitDate).toBeInstanceOf(Date);
    });

    it('stamps a termination date on termination', () => {
      const a = { lifecycleStatus: 'SUSPENDED', isActive: true } as any;

      AssayerStateMachine.terminate(a, 'user-1');

      expect(a.terminationDate).toBeInstanceOf(Date);
    });

    /** HR may already have entered the real last working day; that beats "when the record was updated". */
    it('never overwrites a date already recorded', () => {
      const realLastDay = new Date('2026-03-31');
      const a = { lifecycleStatus: 'ACTIVE', isActive: true, exitDate: realLastDay } as any;

      AssayerStateMachine.acceptResignation(a, 'user-1');

      expect(a.exitDate).toBe(realLastDay);
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
  });
});
