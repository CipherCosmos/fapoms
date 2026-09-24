import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Region } from '@fapoms/shared';
import { RegionGuardService } from './region-guard.service';
import { HrApplicationsController } from '../../modules/assayer/hr-applications.controller';
import { AssayerInterviewController } from '../../modules/assayer/assayer-interview.controller';

/**
 * THE HIRING PIPELINE HAS A REGION CEILING (audit F5, 2026-09-24).
 *
 * A region-assigned desk could list, open, approve or reject a candidate from anywhere in India,
 * while the roster those candidates join was already scoped. A candidate's region is their
 * application's state (the region they will land in on promotion); an interview reaches one through
 * the application its PASS opened. Reads honour `security.regionScope.mode`; writes always enforce.
 */
describe('hiring pipeline region ceiling', () => {
  const west = { regions: [Region.WEST] };
  const make = (mode: string, state: string | null) => {
    const dataSource = { query: jest.fn(async () => [{ state }]) };
    const guard = new RegionGuardService(dataSource as any, { get: jest.fn().mockResolvedValue(mode) } as any);
    return { guard, dataSource };
  };

  it('refuses a write on another region’s candidate whatever the mode', async () => {
    for (const mode of ['off', 'log', 'enforce']) {
      const { guard } = make(mode, 'Kerala');
      await expect(guard.assertApplicationInScope('app-1', west, 'write')).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('refuses a read on another region’s candidate in enforce, lets it through in log', async () => {
    await expect(make('enforce', 'Kerala').guard.assertApplicationInScope('app-1', west, 'read')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make('log', 'Kerala').guard.assertApplicationInScope('app-1', west, 'read')).resolves.toBeUndefined();
  });

  it('allows the caller’s own region, a stateless draft, and a national desk', async () => {
    await expect(make('enforce', 'Maharashtra').guard.assertApplicationInScope('app-1', west, 'write')).resolves.toBeUndefined();
    await expect(make('enforce', null).guard.assertApplicationInScope('app-1', west, 'write')).resolves.toBeUndefined();
    const national = make('enforce', 'Kerala');
    await expect(national.guard.assertApplicationInScope('app-1', { regions: null as any }, 'write')).resolves.toBeUndefined();
    expect(national.dataSource.query).not.toHaveBeenCalled();
  });

  it('scopes an interview through the application it opened', async () => {
    const { guard, dataSource } = make('enforce', 'Kerala');
    await expect(guard.assertInterviewInScope('int-1', west, 'write')).rejects.toBeInstanceOf(ForbiddenException);
    expect(String((dataSource.query.mock.calls as any[])[0][0])).toMatch(/spawned_application_id/);
  });

  it('narrows the queue in enforce, and not in off/log', async () => {
    const rows = [{ id: 'a', state: 'Maharashtra' }, { id: 'b', state: 'Kerala' }, { id: 'c', state: null }];
    expect((await make('enforce', null).guard.narrowApplicationsToScope(rows, west)).map((r) => r.id)).toEqual(['a', 'c']);
    expect(await make('log', null).guard.narrowApplicationsToScope(rows, west)).toHaveLength(3);
    expect(await make('off', null).guard.narrowApplicationsToScope(rows, west)).toHaveLength(3);
  });

  describe('every route asserts before it touches the row', () => {
    const refusing = { assertApplicationInScope: jest.fn(async () => { throw new ForbiddenException('not yours'); }),
      assertInterviewInScope: jest.fn(async () => { throw new ForbiddenException('not yours'); }) };
    const apps = { getApplication: jest.fn(), approve: jest.fn(), reject: jest.fn(), requestMoreInfo: jest.fn(),
      updateStaffDraft: jest.fn(), documentFileKey: jest.fn(), resendInvite: jest.fn() };
    const hr = new HrApplicationsController(apps as any, refusing as any);
    const req = { user: { id: 'u', roles: [], organizationId: 'o' } };

    it.each([
      ['GET :id', () => hr.get('app-1', west as any)],
      ['PATCH :id', () => hr.updateStaffDraft('app-1', {} as any, req, west as any)],
      ['GET scan', () => hr.readDocument('app-1', 'PAN_CARD', 0, {}, west as any)],
      ['approve', () => hr.approve('app-1', {} as any, req, west as any)],
      ['reject', () => hr.reject('app-1', { reason: 'x' } as any, req, west as any)],
      ['resend', () => hr.resendInvite('app-1', req, west as any)],
      ['request-info', () => hr.requestMoreInfo('app-1', { notes: 'x' } as any, req, west as any)],
    ])('%s', async (_label, call) => {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      for (const fn of Object.values(apps)) expect(fn).not.toHaveBeenCalled();
    });

    it('interview amend / file upload / file read', async () => {
      const svc = { amend: jest.fn(), fileKey: jest.fn(), attachFile: jest.fn() };
      const iv = new AssayerInterviewController(svc as any, {} as any, refusing as any);
      await expect(iv.amend('int-1', {} as any, req, west as any)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(iv.getFile('int-1', '0', {}, west as any)).rejects.toBeInstanceOf(ForbiddenException);
      expect(svc.amend).not.toHaveBeenCalled();
      expect(svc.fileKey).not.toHaveBeenCalled();
    });
  });
});
