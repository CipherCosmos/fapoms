import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AssayerController } from './assayer.controller';
import { DocumentVerification, ONBOARDING_DOCUMENT_COLUMNS } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { RosterRecordsService } from './roster-records.service';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * The paperwork tally on the roster row.
 *
 * The list endpoint returned no document rows at all, so "Documents to check" could only ever
 * mean "is at the DOCUMENT_VERIFICATION lifecycle stage" — which says nothing about whether
 * there is anything to look at.
 */
describe('GET /assayers — the per-row document summary', () => {
  let service: AssayerService;
  let assayers: any;
  let query: jest.Mock;

  beforeEach(async () => {
    query = jest.fn().mockResolvedValue([]);
    assayers = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      find: jest.fn().mockResolvedValue([]),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: {} },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn() } },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

  const page = (rows: Array<{ id: string }>) => {
    assayers.findAndCount.mockResolvedValue([rows, rows.length]);
  };

  it('reports the tally the reviewer needs, and zeros for somebody with no paperwork on file', async () => {
    page([{ id: 'a-1' }, { id: 'a-2' }]);
    query.mockResolvedValue([
      { assayer_id: 'a-1', with_scan: 6, verified: 2, awaiting_verdict: 4 },
    ]);

    const { assayers: rows } = await service.findAll(1, 20);
    const byId = Object.fromEntries(rows.map((r: any) => [r.id, r.documents]));

    expect(byId['a-1']).toEqual({
      required: Object.keys(ONBOARDING_DOCUMENT_COLUMNS).length,
      withScan: 6,
      verified: 2,
      awaitingVerdict: 4,
    });
    // Not absent from the queue — the emptiest case of it.
    expect(byId['a-2']).toEqual({
      required: Object.keys(ONBOARDING_DOCUMENT_COLUMNS).length,
      withScan: 0,
      verified: 0,
      awaitingVerdict: 0,
    });
  });

  /**
   * The denominator has to be the checklist the record itself renders
   * (`RosterRecordsService.paperworkChecklist` walks the same map). A row saying "4 of 12" that
   * opens onto a checklist of a different length is a bug nobody reports and everybody distrusts.
   */
  it('uses the same requirement list the dossier checklist does', async () => {
    page([{ id: 'a-1' }]);
    const { assayers: [row] } = await service.findAll(1, 20);
    expect((row as any).documents.required).toBe(Object.keys(ONBOARDING_DOCUMENT_COLUMNS).length);
    expect((row as any).documents.required).toBe(21);
  });

  /**
   * `soft_copy_received` was seeded from the spreadsheet's tick boxes: it is true on 10,977 of the
   * 11,160 active document rows while exactly 0 of them have a file attached. A queue built on it
   * would put essentially the whole roster in front of a reviewer with nothing to review.
   */
  it('counts a scan on file, never the spreadsheet tick', async () => {
    page([{ id: 'a-1' }]);
    await service.findAll(1, 20);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain('jsonb_array_length(file_paths) > 0');
    expect(sql).not.toContain('soft_copy_received');
  });

  it('asks a verdict question that only counts rows there is something to judge', async () => {
    page([{ id: 'a-1' }]);
    await service.findAll(1, 20);

    const [sql, params] = query.mock.calls[0];
    // awaiting = has a scan AND nobody has said verified or rejected yet.
    expect(sql).toMatch(/awaiting_verdict/);
    expect(sql).toContain('verification_status IS NULL');
    expect(params).toEqual([['a-1'], DocumentVerification.VERIFIED, DocumentVerification.PENDING]);
  });

  /** The list serves up to 1,000 people; a query per row would be 1,000 round trips. */
  it('runs one grouped query for the whole page, not one per row', async () => {
    page([{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }, { id: 'a-4' }]);
    await service.findAll(1, 20);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('GROUP BY assayer_id');
    expect(query.mock.calls[0][1][0]).toEqual(['a-1', 'a-2', 'a-3', 'a-4']);
  });

  it('asks nothing at all for an empty page', async () => {
    page([]);
    await service.findAll(1, 20);
    expect(query).not.toHaveBeenCalled();
  });

  it('counts only live document rows', async () => {
    page([{ id: 'a-1' }]);
    await service.findAll(1, 20);
    expect(query.mock.calls[0][0]).toContain('is_active = true');
  });
});

/**
 * `preferredContactChannel` had a column and a comment explaining it exists for people with no
 * smartphone, and no way in through the API: it was in neither request DTO, so all 1,163 roster
 * rows sit on the `AUTO` default and HR could not say otherwise. AUTO infers the channel from
 * whether a device token exists, which for somebody with no smartphone AND no phone number
 * resolves to PHONE and produces a call task with nothing to call.
 */
describe('preferredContactChannel is settable', () => {
  let service: AssayerService;
  let assayers: any;
  let saved: any;

  const ASSAYER_ID = 'a-1';

  beforeEach(async () => {
    saved = null;
    assayers = {
      findOne: jest.fn().mockResolvedValue({
        id: ASSAYER_ID, assayerCode: 'AS0001', displayName: 'A B',
        firstName: 'A', lastName: 'B', state: 'Maharashtra', preferredContactChannel: 'AUTO',
      }),
      save: jest.fn((row: any) => { saved = row; return Promise.resolve(row); }),
      find: jest.fn().mockResolvedValue([]),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query: jest.fn().mockResolvedValue([]) },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn((r) => r), save: jest.fn() } },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn() } },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

  it.each(['PHONE', 'APP', 'AUTO'])('applies %s through the update path', async (channel) => {
    await service.update(ASSAYER_ID, { preferredContactChannel: channel } as any, 'user-1');
    expect(saved.preferredContactChannel).toBe(channel);
  });

  /**
   * The other half, and the half that made the field unreachable: the global pipe whitelists
   * against the REQUEST DTO, so a field the service will happily apply is stripped before the
   * service ever sees it — the request succeeds and the value is silently dropped. Run against
   * the real classes bound to the routes, the way `assayer-identity-dto.spec.ts` does.
   */
  describe('through the real request DTOs bound to the routes', () => {
    const pipe = new ValidationPipe({
      whitelist: true, forbidNonWhitelisted: true, transform: true,
      transformOptions: { enableImplicitConversion: true },
    });
    const CreateDto = Reflect.getMetadata('design:paramtypes', AssayerController.prototype, 'create')?.[0];
    const UpdateDto = Reflect.getMetadata('design:paramtypes', AssayerController.prototype, 'update')?.[1];

    it.each(['AUTO', 'APP', 'PHONE'])('survives the whitelisting pipe on create and update: %s', async (channel) => {
      await expect(pipe.transform(
        { firstName: 'Asha', lastName: 'Nair', state: 'Kerala', preferredContactChannel: channel },
        { type: 'body', metatype: CreateDto },
      )).resolves.toMatchObject({ preferredContactChannel: channel });

      await expect(pipe.transform(
        { preferredContactChannel: channel }, { type: 'body', metatype: UpdateDto },
      )).resolves.toMatchObject({ preferredContactChannel: channel });
    });

    /**
     * The column is a `varchar(10)` with no check constraint behind it, so this list is the only
     * thing between it and a typo the dispatcher would read as "not APP, therefore PHONE".
     */
    it('refuses a channel the dispatcher would not understand', async () => {
      await expect(pipe.transform(
        { preferredContactChannel: 'WHATSAPP' }, { type: 'body', metatype: UpdateDto },
      )).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

/**
 * Closing a group of import issues in one request.
 *
 * One import problem produces one issue per affected row — a mis-spelled state column across a
 * 68-person branch is 68 entries and ONE decision. Through the per-row route that was 68
 * requests, and a failure partway through left the group half closed with nothing in the queue to
 * say where it stopped.
 */
describe('RosterRecordsService.resolveIssues', () => {
  let service: RosterRecordsService;
  let issues: any;
  let rows: Map<string, any>;

  const ACTOR = 'user-1';

  beforeEach(async () => {
    rows = new Map([
      ['i-1', { id: 'i-1', resolvedAt: null }],
      ['i-2', { id: 'i-2', resolvedAt: null }],
      ['i-3', { id: 'i-3', resolvedAt: null }],
    ]);
    issues = {
      findOne: jest.fn(({ where }: any) => Promise.resolve(rows.get(where.id) ?? null)),
      save: jest.fn((row: any) => Promise.resolve(row)),
      count: jest.fn().mockResolvedValue(280),
    };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: issues },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
  });

  it('closes the whole group under one account of what was decided', async () => {
    const out = await service.resolveIssues(['i-1', 'i-2', 'i-3'], 'State read from the branch master.', ACTOR);

    expect(out.resolved).toBe(3);
    expect(out.failed).toBe(0);
    expect(out.results).toEqual([
      { id: 'i-1', resolved: true }, { id: 'i-2', resolved: true }, { id: 'i-3', resolved: true },
    ]);
    for (const row of rows.values()) {
      expect(row.resolution).toBe('State read from the branch master.');
      expect(row.resolvedBy).toBe(ACTOR);
      expect(row.resolvedAt).toBeInstanceOf(Date);
    }
  });

  /**
   * The failure the per-row loop had: one bad id must not abandon the rest. Somebody else having
   * touched one row of a group is the commonest way two people working the same queue collide.
   */
  it('reports a per-id outcome and still closes the rest', async () => {
    rows.get('i-2')!.resolvedAt = new Date('2026-08-01');

    const out = await service.resolveIssues(['i-1', 'i-2', 'unknown', 'i-3'], 'Decided.', ACTOR);

    expect(out.resolved).toBe(2);
    expect(out.failed).toBe(2);
    expect(out.results).toEqual([
      { id: 'i-1', resolved: true },
      { id: 'i-2', resolved: false, reason: 'Already closed by somebody else.' },
      { id: 'unknown', resolved: false, reason: 'No such import issue.' },
      { id: 'i-3', resolved: true },
    ]);
    // The row somebody else closed keeps THEIR account of it, not ours.
    expect(rows.get('i-2')!.resolution).toBeUndefined();
  });

  /** The queue exists because nothing was guessed. Closing with no account puts the guess back. */
  it('refuses a batch with no account of what was decided', async () => {
    await expect(service.resolveIssues(['i-1'], '   ', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resolveIssues(['i-1'], undefined as any, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(issues.save).not.toHaveBeenCalled();
  });

  /** Otherwise the second copy of an id reports a spurious "already resolved" caused by the first. */
  it('collapses a duplicated id to one outcome', async () => {
    const out = await service.resolveIssues(['i-1', 'i-1', 'i-2'], 'Decided.', ACTOR);

    expect(out.results).toHaveLength(2);
    expect(out.resolved).toBe(2);
    expect(issues.save).toHaveBeenCalledTimes(2);
  });

  /** Read after the writes, so a panel refreshing from this response cannot show a stale count. */
  it('returns the queue depth the batch left behind', async () => {
    const out = await service.resolveIssues(['i-1'], 'Decided.', ACTOR);
    expect(out.openCount).toBe(280);
    // Ordered by when jest actually invoked them, not by where they appear in the source.
    expect(issues.count.mock.invocationCallOrder[0])
      .toBeGreaterThan(issues.save.mock.invocationCallOrder[0]);
  });
});
