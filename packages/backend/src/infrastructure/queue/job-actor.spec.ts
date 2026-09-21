import { jobActorFrom, runAsJobActor } from './job-actor';
import { getRequestContext, runWithRequestContext } from '../../core/context/request-context';
import { tenantFilterId } from '../tenancy/ambient-tenant-context';

/**
 * WHO A BACKGROUND WRITE RUNS AS.
 *
 * Three queues — roster bulk actions, planning writes, document dispatch batches — each carried a
 * hand-built copy of this, and the copies did not even read the same fields. A job that runs with no
 * context looks records up across every organisation and writes audit rows naming nobody.
 */
describe('jobActorFrom', () => {
  it('takes the scope the request itself is running under, not a guess from the user row', () => {
    const actor = runWithRequestContext(
      { userId: 'u1', roleNames: ['OPERATIONS', 'ADMIN'], organizationId: 'org-ctx', displayName: 'Priya (ctx)' },
      () => jobActorFrom({ user: { id: 'u1', roles: [{ name: 'OPERATIONS' }], organizationId: 'org-row', displayName: 'Priya' } }),
    );
    expect(actor).toEqual({ userId: 'u1', roleNames: ['OPERATIONS', 'ADMIN'], organizationId: 'org-ctx', displayName: 'Priya (ctx)' });
  });

  it('falls back to the user row outside a request context, normalising role objects to names', () => {
    const actor = jobActorFrom({ user: { id: 'u2', roles: [{ name: 'DESK' }, 'AUDITOR'], organizationId: 'org-9', username: 'desk.one' } });
    expect(actor).toEqual({ userId: 'u2', roleNames: ['DESK', 'AUDITOR'], organizationId: 'org-9', displayName: 'desk.one' });
  });
});

describe('runAsJobActor', () => {
  it('scopes the work to the actor and leaves nothing behind afterwards', async () => {
    const seen = await runAsJobActor(
      { userId: 'u1', roleNames: ['OPERATIONS'], organizationId: 'org-1', displayName: 'Priya' },
      async () => ({ org: tenantFilterId(), ctx: getRequestContext() }),
    );
    expect(seen.org).toBe('org-1');
    expect(seen.ctx).toMatchObject({ userId: 'u1', role: 'OPERATIONS', roleNames: ['OPERATIONS'], displayName: 'Priya' });
    expect(getRequestContext()).toBeUndefined();
  });

  it('keeps a cross-tenant role that is not listed first', async () => {
    const org = await runAsJobActor(
      { userId: 'u1', roleNames: ['OPERATIONS', 'ADMIN'], organizationId: 'org-1' },
      async () => tenantFilterId(),
    );
    expect(org).toBeNull();
  });
});
