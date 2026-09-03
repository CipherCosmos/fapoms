import { ForbiddenException } from '@nestjs/common';
import { SystemRole } from '@fapoms/shared';
import { AssignmentController } from './assignment.controller';

/**
 * An assayer may open their own assignment and nobody else's.
 *
 * `GET /assignments/:id` was reachable by any signed-in assayer for any assignment id. Its only
 * other gate is the region guard, whose own comment records that it does nothing for an assayer
 * principal — they carry no region — and the route eager-loads `projectBranch.branch` and
 * `assayer`, so the response names the branch holding a customer's pledged gold and the colleague
 * sent to value it.
 *
 * The id is a v4 UUID, so nothing was enumerable and this was never a bulk-harvest route. That is
 * a reason it went unnoticed, not a reason it was safe: an unguessable identifier is not an
 * authorisation check, and ids travel — in logs, in links, in screenshots, in a shared handset.
 *
 * The same ownership test already guarded `POST :id/comments` and the transition route. This read
 * was the one that was missed, which is why the check is asserted here rather than trusted to
 * look right.
 */
describe('reading a single assignment', () => {
  const assignment = (assayerId: string | null) => ({
    id: 'asg-1', assayerId, projectBranch: { branch: { name: 'Fort Branch' } },
  });

  const controllerWith = (found: any) => {
    // Built off the prototype rather than through the constructor: this controller takes a long
    // list of collaborators and only two of them are reachable from this route. Naming the other
    // twenty as undefined would say nothing about the check and would need editing every time an
    // unrelated dependency is added.
    const c: any = Object.create(AssignmentController.prototype);
    c.assignmentService = { findOne: jest.fn().mockResolvedValue(found) };
    c.regionGuard = { assertAssignmentInScope: jest.fn().mockResolvedValue(undefined) };
    return c;
  };

  const asAssayer = (id: string) => ({ user: { id, roles: [SystemRole.ASSAYER] } });

  it('lets an assayer open an assignment that is theirs', async () => {
    const c = controllerWith(assignment('asr-1'));
    const res: any = await (c as any).findOne('asg-1', asAssayer('asr-1'), undefined);
    expect(res.success).toBe(true);
  });

  it('refuses an assayer an assignment belonging to somebody else', async () => {
    const c = controllerWith(assignment('asr-2'));
    await expect((c as any).findOne('asg-1', asAssayer('asr-1'), undefined))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses an assayer an unassigned assignment rather than defaulting open', async () => {
    // A null `assayerId` must not compare equal to a missing caller id and let the read through.
    const c = controllerWith(assignment(null));
    await expect((c as any).findOne('asg-1', asAssayer('asr-1'), undefined))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves staff alone — they are scoped by region, not by ownership', async () => {
    const c = controllerWith(assignment('asr-2'));
    const staff = { user: { id: 'u-9', roles: [SystemRole.OPERATIONS] } };
    const res: any = await (c as any).findOne('asg-1', staff, undefined);
    expect(res.success).toBe(true);
  });
});
