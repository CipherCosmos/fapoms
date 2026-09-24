import { BranchService } from '../branch/branch.service';
import { ProjectService } from '../project/project.service';
import { NOTIFICATION_CATALOG, renderTemplate } from './notification-catalog';

/**
 * Owner decision 2026-09-24: work cancelled because the office closed a branch or stopped a
 * project used to vanish from the assayer's list with no word. They are now told, in plain words,
 * and their phone refreshes.
 */
describe('a closure cancellation reaches the assayer', () => {
  const rows = [
    { id: 'asn-1', assignment_number: 'ASN-1', status: 'ACCEPTED', project_branch_id: 'pb-1', assayer_id: 'assayer-1', branch_name: 'Thrissur Main' },
    { id: 'asn-2', assignment_number: 'ASN-2', status: 'PENDING', project_branch_id: 'pb-2', assayer_id: null, branch_name: 'Kochi' },
  ];
  const dispatch = { emitSafe: jest.fn() };
  const refresh = { assignmentChanged: jest.fn() };
  beforeEach(() => { dispatch.emitSafe.mockClear(); refresh.assignmentChanged.mockClear(); });

  it('branch deactivation', async () => {
    const svc: any = Object.create(BranchService.prototype);
    svc.loadForWrite = jest.fn(async () => ({ id: 'b-1', name: 'Thrissur Main', isActive: true }));
    svc.dataSource = { query: jest.fn(async (sql: string) => (sql.includes('SELECT a.id') ? rows : [])) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.branchRepository = { save: jest.fn(async (b: any) => b) };
    svc.notificationDispatch = dispatch;
    svc.refreshPush = refresh;
    await svc.remove('b-1', 'ops-1').catch(() => undefined);

    const emits = dispatch.emitSafe.mock.calls.map((c) => c[0]);
    expect(emits).toHaveLength(1); // the unassigned job tells nobody
    expect(emits[0]).toMatchObject({
      type: 'ASSIGNMENT_CANCELLED_BY_CLOSURE', assayerId: 'assayer-1',
      payload: { branchName: 'Thrissur Main', because: 'the office has closed this branch' },
    });
    expect(refresh.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
  });

  it('project cancellation', async () => {
    const svc: any = Object.create(ProjectService.prototype);
    svc.findOne = jest.fn(async () => ({ id: 'p-1', name: 'SBI Q3', status: 'EXECUTION' }));
    svc.dataSource = { query: jest.fn(async (sql: string) => (sql.includes('SELECT a.id') ? rows : [])) };
    svc.auditService = { recordEvent: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.projectRepository = { save: jest.fn(async (p: any) => p) };
    svc.workflowEngine = { executeCommand: jest.fn(async (..._a: any[]) => (_a[8] as () => Promise<any>)()) };
    svc.notificationDispatch = dispatch;
    svc.refreshPush = refresh;
    await svc.cancelProject('p-1', 'ops-1').catch(() => undefined);

    const [e] = dispatch.emitSafe.mock.calls.map((c) => c[0]);
    expect(e).toMatchObject({
      type: 'ASSIGNMENT_CANCELLED_BY_CLOSURE', assayerId: 'assayer-1',
      payload: { branchName: 'Thrissur Main', because: 'the office has stopped this audit project' },
    });
    expect(refresh.assignmentChanged).toHaveBeenCalledWith('assayer-1', 'asn-1');
  });

  it('reads plainly on a lock screen', () => {
    const def = NOTIFICATION_CATALOG.ASSIGNMENT_CANCELLED_BY_CLOSURE;
    expect(renderTemplate(def.body, { branchName: 'Thrissur Main', because: 'the office has closed this branch' }))
      .toBe('Your job at Thrissur Main is cancelled because the office has closed this branch. Do not go to the branch for it.');
    expect(renderTemplate(NOTIFICATION_CATALOG.ASSIGNMENT_DATE_CHANGED.body, { branchName: 'Kochi', newDate: 'Monday, 28 September', alsoNote: '' }))
      .toBe('Your job at Kochi is now on Monday, 28 September.');
  });

  it('the dead types are gone from the catalog', () => {
    expect(NOTIFICATION_CATALOG.SCHEDULE_CANCELLED).toBeUndefined();
    expect(NOTIFICATION_CATALOG.DOCUMENT_REJECTED).toBeUndefined();
    for (const t of ['ASSIGNMENT_REOPENED', 'ASSIGNMENT_DATE_CHANGED', 'ASSIGNMENT_NOTE_CHANGED', 'ASSIGNMENT_MARKED_URGENT', 'ASSIGNMENT_CANCELLED_BY_CLOSURE']) {
      expect(NOTIFICATION_CATALOG[t]).toMatchObject({ special: ['ASSIGNED_ASSAYER'], skipActor: true });
    }
  });
});
