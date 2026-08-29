import { AssignmentController } from './assignment.controller';
import { SystemRole } from '@fapoms/shared';

/**
 * The pin for the assayer fee self-dealing guard.
 *
 * `POST /assignments/:id/transition {targetStatus: ACCEPTED, fee: N}` exists so the DESK can
 * accept on an assayer's behalf at a verbally-agreed number. When the caller is the ASSAYER,
 * any supplied fee must be ignored — otherwise they accept their own offer at any amount and,
 * via the valid ACCEPTED→ACCEPTED self-loop, bump it repeatedly until completion books it as
 * their payable.
 *
 * This guard shipped in 85aa82bf and was silently reverted ten minutes later by 89fd422e,
 * a workforce fix that touched the controller as collateral from a shared working tree. It was
 * open on HEAD for nine days. This spec exists so the third revert fails CI instead of shipping.
 */
describe('assignment transition — accept-fee authority', () => {
  function makeController() {
    const acceptOffer = jest.fn().mockResolvedValue({ id: 'a-1', status: 'ACCEPTED' });
    // ownership check: `owned.assayerId !== userId` — the assignment belongs to the caller
    const assignmentService = { acceptOffer, findOne: jest.fn().mockResolvedValue({ assayerId: 'user-1' }) };
    const controller = new AssignmentController(
      assignmentService as any,
      { recordDecision: jest.fn() } as any,
      { assertAssignmentInScope: jest.fn(), assertBranchInScope: jest.fn() } as any,
    );
    return { controller, acceptOffer };
  }

  const reqAs = (roles: string[], id = 'user-1') => ({ user: { id, roles } });

  it('ignores a fee supplied by the assayer — accepts at the standing proposedFee', async () => {
    const { controller, acceptOffer } = makeController();
    await controller.transition(
      'a-1',
      { targetStatus: 'ACCEPTED', fee: 250000 },
      reqAs([SystemRole.ASSAYER]),
    );
    expect(acceptOffer).toHaveBeenCalledTimes(1);
    // the fee argument (3rd) must be undefined — the service then uses the negotiated proposedFee
    expect(acceptOffer.mock.calls[0][2]).toBeUndefined();
  });

  it('passes the desk-supplied fee through for staff (the phone-channel flow)', async () => {
    const { controller, acceptOffer } = makeController();
    await controller.transition(
      'a-1',
      { targetStatus: 'ACCEPTED', fee: 1800 },
      reqAs([SystemRole.OPERATIONS]),
    );
    expect(acceptOffer).toHaveBeenCalledTimes(1);
    expect(acceptOffer.mock.calls[0][2]).toBe(1800);
  });

  it('ignores the agreedFee alias from an assayer too', async () => {
    const { controller, acceptOffer } = makeController();
    await controller.transition(
      'a-1',
      { targetStatus: 'ACCEPTED', agreedFee: 999999 },
      reqAs([SystemRole.ASSAYER]),
    );
    expect(acceptOffer.mock.calls[0][2]).toBeUndefined();
  });
});
