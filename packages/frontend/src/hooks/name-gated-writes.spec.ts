import { SystemRole } from '@fapoms/shared';
import { canDeleteAssayers, canDeleteProjects, canEditClientBilling } from './useCurrentRoles';

jest.mock('../services/api', () => ({ api: { request: jest.fn() } }));

/**
 * Buttons whose route is a role NAME on the server (`@Roles(ADMIN)`, no permission fallback):
 * DELETE /assayers/:id, DELETE /projects/:id, PUT /clients/:id/billing. Offered to anybody else,
 * the click could only 403 — OPERATIONS and custom roles hold the matching permission keys for
 * other routes, which is how these gates used to let them through.
 */
describe.each([
  ['delete an assayer', canDeleteAssayers],
  ['delete a project', canDeleteProjects],
  ['edit a client’s billing terms', canEditClientBilling],
])('%s', (_label, gate) => {
  it('ADMIN, and DEVELOPER through the hierarchy', () => {
    expect(gate([SystemRole.ADMIN], [])).toBe(true);
    expect(gate([SystemRole.DEVELOPER], [])).toBe(true);
  });

  it('not OPERATIONS, not a custom role — whatever permissions they hold', () => {
    const everything = ['ASSAYER:DELETE:ORGANIZATION', 'PROJECT:DELETE:ORGANIZATION', 'CLIENT:EDIT:ORGANIZATION'];
    expect(gate([SystemRole.OPERATIONS], everything)).toBe(false);
    expect(gate(['HR_LEAD' as SystemRole], everything)).toBe(false);
  });
});

describe('canListClients (GET /clients: staff role names, no fallback)', () => {
  it('staff roles yes, a custom role no — so the Command Center does not ask in the background', async () => {
    const { canListClients } = await import('./useCurrentRoles');
    expect(canListClients([SystemRole.AUDITOR])).toBe(true);
    expect(canListClients([SystemRole.DEVELOPER])).toBe(true);
    expect(canListClients(['MAP_VIEWER' as SystemRole])).toBe(false);
  });
});
