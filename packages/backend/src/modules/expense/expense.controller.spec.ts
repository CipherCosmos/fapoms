import { Reflector } from '@nestjs/core';
import { SystemRole } from '@fapoms/shared';

import { ExpenseController } from './expense.controller';
import { ROLES_KEY } from '../auth/guards';

/**
 * `POST assignments/:assignmentId/expenses` used to carry `@Roles(ASSAYER, ...STAFF_ROLES)`,
 * which put AUDITOR — meant to be strictly read-only, per `expenses/pending` and
 * `expenses/:id/review` just below drawing exactly that line — on the one write in this
 * controller. Nothing downstream narrowed it back: `ExpenseService.create`'s only checks are a
 * region guard (a no-op for a principal with no region assignment) and an assayer-ownership
 * check that is skipped entirely for any non-assayer caller. So an AUDITOR token could inject a
 * reimbursement claim into the same book the role exists to review.
 *
 * Checked directly against the route's own metadata, the way `RolesGuard` reads it — a full
 * request-pipeline test would need this route's DTO validation and service wired up for no
 * extra coverage of the actual regression.
 */
describe('ExpenseController — POST assignments/:assignmentId/expenses roles', () => {
  it('admits ASSAYER and the desk-side staff who file a claim on someone else\'s behalf', () => {
    const reflector = new Reflector();
    const handler = ExpenseController.prototype.create;
    const roles = reflector.get<SystemRole[]>(ROLES_KEY, handler);
    expect(roles).toEqual(
      expect.arrayContaining([
        SystemRole.ASSAYER,
        SystemRole.ADMIN,
        SystemRole.OPERATIONS,
        SystemRole.DESK,
        SystemRole.DESK_OPERATOR,
      ]),
    );
  });

  it('does not admit AUDITOR or PRODUCT_SUPPORT — origination is not oversight', () => {
    const reflector = new Reflector();
    const roles = reflector.get<SystemRole[]>(ROLES_KEY, ExpenseController.prototype.create);
    expect(roles).not.toContain(SystemRole.AUDITOR);
    expect(roles).not.toContain(SystemRole.PRODUCT_SUPPORT);
  });

  it('leaves the paired read route (list claims on an assignment) at the full staff set, AUDITOR included', () => {
    const reflector = new Reflector();
    const roles = reflector.get<SystemRole[]>(ROLES_KEY, ExpenseController.prototype.findForAssignment);
    expect(roles).toEqual(expect.arrayContaining([SystemRole.ASSAYER, SystemRole.AUDITOR]));
  });
});
