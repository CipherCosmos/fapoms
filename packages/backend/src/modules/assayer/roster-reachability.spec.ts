import { readFileSync } from 'fs';
import { join } from 'path';
import { SystemRole } from '@fapoms/shared';
import { scopeAssayerForRoles } from './assayer-visibility';

/**
 * Every row on the roster opens.
 *
 * The role consolidation rewrote each `@Roles(...)` list on its own, and these two drifted
 * apart: the list route kept the desk and the auditor, the detail route was cut to two roles.
 * The result was a roster that rendered in full for those people and a 403 behind every row —
 * which the web app turns into a bounce back to the dashboard. Nothing in the UI said why.
 *
 * The invariant is the one thing that makes a list page honest: if you can see a row, you can
 * open it. What you are allowed to see *inside* is a separate question, answered by field
 * redaction, which is default-deny and pinned below.
 */
describe('the assayer roster', () => {
  const controller = readFileSync(join(__dirname, 'assayer.controller.ts'), 'utf8');

  /** The roles named on the `@Roles(...)` immediately above a given route decorator. */
  const rolesGuarding = (routeDecorator: string): string[] => {
    const at = controller.indexOf(routeDecorator);
    expect(at).toBeGreaterThan(-1);
    const before = controller.slice(0, at);
    const roles = before.slice(before.lastIndexOf('@Roles('));
    return [...roles.matchAll(/SystemRole\.(\w+)/g)].map((m) => m[1]).sort();
  };

  it('lets everyone who can list an assayer open one', () => {
    const list = rolesGuarding("@Get()\n  @ApiOperation({ summary: 'List all registered assayers' })");
    const detail = rolesGuarding("@Get(':id')");

    expect(list.length).toBeGreaterThan(0);
    // Subset, not equality: the detail route may admit more (an assayer opening their own
    // record), never fewer.
    expect(detail).toEqual(expect.arrayContaining(list));
  });

  it('names each role once — a duplicate is a rename that went wrong', () => {
    const editors = controller
      .slice(controller.indexOf('const STAFF_ASSAYER_EDITORS'))
      .slice(0, controller.slice(controller.indexOf('const STAFF_ASSAYER_EDITORS')).indexOf('];'));
    const named = [...editors.matchAll(/SystemRole\.(\w+)/g)].map((m) => m[1]);
    expect(named).toEqual([...new Set(named)]);
  });

  it.each([SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR])(
    'shows %s the operational record and none of the private one',
    (role) => {
      const full = {
        id: 'as-1', displayName: 'Belekar', phone: '9000000000', state: 'Maharashtra',
        panNumber: 'ABCDE1234F', aadhaarNumber: '1111 2222 3333', dateOfBirth: '1990-01-01',
        bankAccountNumber: '000123456789', ifscCode: 'HDFC0000123',
        passwordHash: 'never-this',
      };

      const seen = scopeAssayerForRoles(full, [role]) as Record<string, unknown>;

      // Enough to do the job...
      expect(seen.displayName).toBe('Belekar');
      expect(seen.state).toBe('Maharashtra');
      // ...and nothing that only payroll and onboarding need.
      for (const secret of ['panNumber', 'aadhaarNumber', 'dateOfBirth', 'bankAccountNumber', 'ifscCode', 'passwordHash']) {
        expect(seen[secret]).toBeUndefined();
      }
    },
  );
});
