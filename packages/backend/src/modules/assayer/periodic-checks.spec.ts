import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  AssayerLifecycleStatus, BackgroundCheckVerdict, CheckReviewDecision, CheckType, OnboardingDocument,
} from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerDocumentVersionEntity } from './assayer-document-version.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { ComplianceReviewService } from './compliance-review.service';
import { ComplianceStandingService } from './compliance-standing.service';

/**
 * CHECKS DONE OVER TIME (owner, 2026-09-23): background, police, credit and identity re-checks,
 * each its own dated record with its own report; an adverse one on somebody working holds them from
 * new work until a senior decides.
 */
describe('recording a re-check', () => {
  let service: RosterRecordsService;
  let saved: any[];
  let docs: Record<string, any>;
  let person: any;
  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn().mockResolvedValue(undefined) };
  const notifications = { emitSafe: jest.fn() };
  const assayers = { findOne: jest.fn(async () => person), update: jest.fn(async (_w: any, patch: any) => Object.assign(person, patch)) };

  const upload = (requirement: OnboardingDocument, path: string, issuedBy = 'Agency') => {
    docs[requirement] = docs[requirement] ?? { id: `doc-${requirement}`, assayerId: 'a-1', requirement, filePaths: [], issuedBy };
    docs[requirement].filePaths.push(path);
  };
  const record = (over: Record<string, unknown>) => service.recordBackgroundCheck('a-1', over as never, 'hr-1');

  beforeEach(async () => {
    saved = [];
    docs = {};
    person = { id: 'a-1', displayName: 'Ramesh Kumar', lifecycleStatus: AssayerLifecycleStatus.ACTIVE, complianceHold: null };
    const checks = {
      find: jest.fn(async () => saved),
      findOne: jest.fn(async ({ where }: any) => [...saved].reverse().find((c) => !where.checkType || c.checkType === where.checkType) ?? null),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (v: any) => { const row = { id: `chk-${saved.length + 1}`, ...v }; saved.push(row); return row; }),
    };
    const onboarding = {
      findOne: jest.fn(async ({ where }: any) => docs[where.requirement] ?? null),
      find: jest.fn(async () => Object.values(docs)),
      save: jest.fn(async (v: any) => v),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: checks },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerDocumentVersionEntity), useValue: { find: jest.fn(async () => []), findOne: jest.fn(async () => null) } },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: {} },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: NotificationDispatchService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
    jest.clearAllMocks();
  });

  it('records a police verification with its own certificate and issuing station', async () => {
    upload(OnboardingDocument.POLICE_CERTIFICATE, 'police/cert.pdf', 'Shivajinagar PS');
    const check = await record({ checkType: CheckType.POLICE, verdict: BackgroundCheckVerdict.CLEAR });
    expect(check).toMatchObject({ checkType: CheckType.POLICE, checkedByName: 'Shivajinagar PS' });
    expect(check.reportFiles.map((f: any) => f.path)).toEqual(['police/cert.pdf']);
  });

  it('will not take a police result on the background report', async () => {
    upload(OnboardingDocument.BGV_REPORT, 'bgv/report.pdf');
    await expect(record({ checkType: CheckType.POLICE, verdict: BackgroundCheckVerdict.CLEAR }))
      .rejects.toThrow(/Upload the police verification certificate/);
  });

  it('asks the identity re-check to say what was re-checked, since it has no report of its own', async () => {
    await expect(record({ checkType: CheckType.IDENTITY, verdict: BackgroundCheckVerdict.CLEAR }))
      .rejects.toThrow(/Say which identity documents were re-checked/);
    await expect(record({ checkType: CheckType.IDENTITY, verdict: BackgroundCheckVerdict.CLEAR, findings: 'PAN and Aadhaar seen in original, match.' }))
      .resolves.toMatchObject({ checkType: CheckType.IDENTITY, reportFiles: [] });
  });

  it('holds somebody WORKING from new work on an adverse re-check, and tells the approvers', async () => {
    upload(OnboardingDocument.CREDIT_REPORT, 'credit/cibil.pdf', 'CIBIL');
    const check = await record({ checkType: CheckType.CREDIT, verdict: BackgroundCheckVerdict.ADVERSE_FINDING, findings: 'Two defaults in 2026.' });

    expect(check.reviewStatus).toBe('PENDING');
    expect(person.complianceHold).toMatchObject({ checkId: check.id, checkType: CheckType.CREDIT, verdict: 'ADVERSE_FINDING' });
    expect(notifications.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ASSAYER_RECHECK_ADVERSE', payload: expect.objectContaining({ checkLabel: 'Credit (CIBIL) check', outcome: 'Adverse finding' }),
    }));
  });

  it('leaves a joiner\'s adverse check to onboarding — no hold, no review', async () => {
    person.lifecycleStatus = AssayerLifecycleStatus.BACKGROUND_VERIFICATION;
    upload(OnboardingDocument.BGV_REPORT, 'bgv/report.pdf');
    const check = await record({ verdict: BackgroundCheckVerdict.CRIMINAL_CASE });
    expect(check.reviewStatus).toBeUndefined();
    expect(person.complianceHold).toBeNull();
  });

  /** Onboarding asks about background verification — a police or credit check is not that. */
  it('keeps the onboarding gate on background verification alone', async () => {
    upload(OnboardingDocument.BGV_REPORT, 'bgv/report.pdf');
    await record({ verdict: BackgroundCheckVerdict.CLEAR });
    upload(OnboardingDocument.POLICE_CERTIFICATE, 'police/cert.pdf');
    await record({ checkType: CheckType.POLICE, verdict: BackgroundCheckVerdict.CRIMINAL_CASE, findings: 'x' });

    await expect(service.latestBackgroundVerdict('a-1')).resolves.toBe(BackgroundCheckVerdict.CLEAR);
  });

  it('asks for the issuer of every report it takes', async () => {
    await expect(service.attachFile('a-1', OnboardingDocument.POLICE_CERTIFICATE, 'k', 'hr-1', undefined, ''))
      .rejects.toThrow(/Name the issuing police station/);
  });
});

describe('a senior\'s decision on an adverse re-check', () => {
  const setup = (over: { lifecycle?: string; recorder?: string; otherPending?: boolean } = {}) => {
    const check: any = { id: 'chk-1', assayerId: 'a-1', checkType: CheckType.POLICE, verdict: 'CRIMINAL_CASE', reviewStatus: 'PENDING', createdBy: over.recorder ?? 'hr-1' };
    const other: any = { id: 'chk-2', assayerId: 'a-1', checkType: CheckType.CREDIT, verdict: 'ADVERSE_FINDING', reviewStatus: 'PENDING', createdBy: 'hr-1' };
    const holdWrites: any[] = [];
    const checksRepo = {
      findOne: jest.fn(async ({ where }: any) => {
        if (where.id === 'chk-1') return check;
        if (where.reviewStatus === 'PENDING') return over.otherPending ? other : null;
        return null;
      }),
      save: jest.fn(async (v: any) => v),
    };
    const manager = {
      getRepository: (e: any) => (e.name === 'AssayerEntity'
        ? { update: jest.fn(async (_w: any, patch: any) => { holdWrites.push(patch.complianceHold); }) }
        : checksRepo),
    };
    const unitOfWork = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
    const assayerService = {
      findOne: jest.fn(async () => ({ id: 'a-1', displayName: 'Ramesh Kumar', lifecycleStatus: over.lifecycle ?? 'ACTIVE' })),
      transitionLifecycle: jest.fn(async () => ({})),
    };
    const audit = { recordEventSafe: jest.fn(async () => undefined) };
    const notifications = { emitSafe: jest.fn() };
    const service = new ComplianceReviewService(assayerService as any, audit as any, unitOfWork as any, notifications as any);
    return { service, check, holdWrites, assayerService, notifications };
  };
  const BOSS = { id: 'boss-1', name: 'Rao' };

  it('keeps them working with a reason, and lifts the hold', async () => {
    const { service, check, holdWrites, assayerService, notifications } = setup();
    await service.decide('a-1', 'chk-1', CheckReviewDecision.KEEP, 'Old matter, acquitted in 2019 — papers seen.', BOSS);
    expect(check).toMatchObject({ reviewStatus: 'KEPT', reviewedBy: BOSS.id });
    expect(holdWrites).toEqual([null]);
    expect(assayerService.transitionLifecycle).not.toHaveBeenCalled();
    expect(notifications.emitSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'ASSAYER_RECHECK_REVIEWED', ownerUserId: 'hr-1' }));
  });

  it('suspends them through the lifecycle, with the reason', async () => {
    const { service, check, assayerService } = setup();
    await service.decide('a-1', 'chk-1', CheckReviewDecision.SUSPEND, 'Pending criminal case; cannot enter a vault.', BOSS);
    expect(assayerService.transitionLifecycle).toHaveBeenCalledWith('a-1', 'SUSPENDED', BOSS.id, expect.stringMatching(/Police verification came back adverse/));
    expect(check.reviewStatus).toBe('SUSPENDED');
  });

  it('moves the hold to the next adverse check still waiting', async () => {
    const { service, holdWrites } = setup({ otherPending: true });
    await service.decide('a-1', 'chk-1', CheckReviewDecision.KEEP, 'Old matter, acquitted in 2019 — papers seen.', BOSS);
    expect(holdWrites[0]).toMatchObject({ checkId: 'chk-2', checkType: CheckType.CREDIT });
  });

  it('will not let whoever recorded the check decide it, nor decide without a reason', async () => {
    const { service } = setup({ recorder: BOSS.id });
    await expect(service.decide('a-1', 'chk-1', CheckReviewDecision.KEEP, 'Fine by me, all good here.', BOSS)).rejects.toBeInstanceOf(ForbiddenException);
    const again = setup();
    await expect(again.service.decide('a-1', 'chk-1', CheckReviewDecision.KEEP, 'ok', BOSS)).rejects.toThrow(/Say why/);
  });

  it('suspends only somebody active', async () => {
    const { service } = setup({ lifecycle: 'ON_LEAVE' });
    await expect(service.decide('a-1', 'chk-1', CheckReviewDecision.SUSPEND, 'Pending criminal case; cannot enter a vault.', BOSS))
      .rejects.toBeInstanceOf(ConflictException);
  });
});

describe('where people stand', () => {
  it('answers many people with three queries, and only re-checks people who work', async () => {
    const queries: string[] = [];
    const manager = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM assayers')) {
          return [
            { id: 'a-1', lifecycle_status: 'ACTIVE', compliance_hold: null },
            { id: 'a-2', lifecycle_status: 'TRAINING', compliance_hold: null },
          ];
        }
        if (sql.includes('assayer_background_checks')) {
          return [{ assayer_id: 'a-1', check_type: 'POLICE', checked_on: '2025-01-01', verdict: 'CLEAR' }];
        }
        return [];
      }),
    };
    const service = new ComplianceStandingService({ run: async (w: any) => w(manager) } as any);
    const map = await service.standingsFor(['a-1', 'a-2'], '2026-09-23');

    expect(queries).toHaveLength(3);
    const a1 = map.get('a-1')!;
    expect(a1.standings.find((s) => s.type === CheckType.POLICE)).toMatchObject({ dueOn: '2026-01-01', status: 'BLOCKED' });
    expect(a1.blockers).toEqual(['Police verification overdue since 2026-01-01']);
    expect(map.get('a-2')).toMatchObject({ rechecked: false, standings: [], blockers: [] });
  });

  /**
   * `lifecycle_status` is a Postgres ENUM: compared with a text array it is an error, not an empty
   * list — found by running the query against the live database, which the stubbed ones cannot.
   */
  it('compares the lifecycle as text when listing who needs attention', async () => {
    const sql: string[] = [];
    const manager = { query: jest.fn(async (q: string) => { sql.push(q); return []; }) };
    const service = new ComplianceStandingService({ run: async (w: any) => w(manager) } as any);
    await service.attentionList('2026-09-23', null);
    expect(sql[0]).toMatch(/lifecycle_status::text = ANY\(\$1::text\[\]\)/);
  });
});
