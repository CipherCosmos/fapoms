import { AssayerLifecycleStatus } from '@fapoms/shared';
import {
  ASSAYER_LIFECYCLE_TRANSITIONS,
  canTransitionAssayerLifecycle,
  nextAssayerLifecycleStates,
  assayerLifecyclePath,
} from '@fapoms/shared';

/**
 * The lifecycle map used to exist four times — once here on the server, which enforces it, and
 * three hand-copied times in the web app, which offers it. The copies had drifted in both
 * directions at once: they offered edges the server rejects, and hid edges it allows.
 *
 * These tests pin the edges that were wrong, so a future edit cannot quietly reintroduce either
 * failure.
 */
describe('assayer lifecycle', () => {
  describe('edges the UI used to offer but the server rejects', () => {
    it('does not allow an active assayer to be terminated directly', () => {
      // Termination follows suspension; sacking someone without a suspension on record is
      // exactly the sort of step an audit of the workforce needs to see.
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.TERMINATED)).toBe(false);
      expect(nextAssayerLifecycleStates(AssayerLifecycleStatus.ACTIVE)).not.toContain(AssayerLifecycleStatus.TERMINATED);
    });

    it('does not allow someone on leave to resign without returning first', () => {
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.ON_LEAVE, AssayerLifecycleStatus.RESIGNED)).toBe(false);
    });
  });

  describe('edges the server allows but the UI used to hide', () => {
    it('lets a leaver be archived', () => {
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.RESIGNED, AssayerLifecycleStatus.ARCHIVED)).toBe(true);
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.TERMINATED, AssayerLifecycleStatus.ARCHIVED)).toBe(true);
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.ARCHIVED)).toBe(true);
    });

    it('lets onboarding be abandoned at any stage', () => {
      for (const stage of [
        AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
        AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
        AssayerLifecycleStatus.TRAINING,
      ]) {
        expect(nextAssayerLifecycleStates(stage)).toContain(AssayerLifecycleStatus.INACTIVE);
      }
    });

    it('lets an inactive assayer be brought back', () => {
      expect(canTransitionAssayerLifecycle(AssayerLifecycleStatus.INACTIVE, AssayerLifecycleStatus.ACTIVE)).toBe(true);
    });
  });

  describe('multi-step paths', () => {
    it('routes a trainee to archived only through states that exist', () => {
      const path = assayerLifecyclePath(AssayerLifecycleStatus.TRAINING, AssayerLifecycleStatus.ARCHIVED);
      expect(path).not.toBeNull();

      // Every hop must be a real edge — the roster walks this path one transition at a time,
      // so an invented edge fails part-way and leaves a bulk change half-applied.
      let from: string = AssayerLifecycleStatus.TRAINING;
      for (const hop of path!) {
        expect(canTransitionAssayerLifecycle(from, hop)).toBe(true);
        from = hop;
      }
      expect(from).toBe(AssayerLifecycleStatus.ARCHIVED);
    });

    it('returns an empty path when already there, and null when unreachable', () => {
      expect(assayerLifecyclePath(AssayerLifecycleStatus.ACTIVE, AssayerLifecycleStatus.ACTIVE)).toEqual([]);
      // Archived is the end of the line; nothing leads out of it.
      expect(assayerLifecyclePath(AssayerLifecycleStatus.ARCHIVED, AssayerLifecycleStatus.ACTIVE)).toBeNull();
    });
  });

  it('never lists a destination that has no entry of its own', () => {
    for (const [from, targets] of Object.entries(ASSAYER_LIFECYCLE_TRANSITIONS)) {
      for (const to of targets) {
        expect(Object.values(AssayerLifecycleStatus)).toContain(to);
        expect(to).not.toEqual(from);
      }
    }
  });
});
