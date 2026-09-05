import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
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
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';

/**
 * THE HYDRATION BUG.
 *
 * `GET /assayers` sends a filtered or keyset request to `RosterQueryService` — a read path
 * entirely separate from `AssayerService.findAll` — and until `hydrateRosterRows` existed, only
 * `findAll` ran the three grouped hydration queries that attach skills/certifications/languages/
 * specializations (`hydrateAllWorkforceAttributes`), a paperwork tally
 * (`hydrateDocumentSummaries`) and an empanelment tally (`hydrateEmpanelmentSummary`, called from
 * inside the document hydration) to a page of rows. A request carrying `?after=` or any filter
 * therefore came back with every one of those fields `undefined`: the roster screen's page-2+
 * rows silently lost them, the Documents filter had nothing to filter on, and skill/certification
 * counts read as zero for real people who hold both.
 *
 * Two different failure modes are guarded here, because one kind of test cannot see the other.
 * `hydrateRosterRows` itself could be correct and still never get called by a caller — so this
 * file has both a behavioural test (the fix produces the right shape) and a source-reading test
 * (both controller branches actually call it), in the style `assayer-controller-region-scope.spec.ts`
 * already established for exactly this kind of "a per-route fix silently unapplied to a sibling
 * route" defect.
 */

// ── Part 1: the fix produces the same shape findAll already does ─────────────────────────────

describe('roster hydration parity — AssayerService.hydrateRosterRows', () => {
  const WORKFORCE_ATTRS = [
    { assayerId: 'a-1', type: 'SKILL', name: 'Gold Assaying', expiryDate: null },
    { assayerId: 'a-1', type: 'CERTIFICATION', name: 'BIS Hallmarking', expiryDate: new Date('2027-06-01') },
    { assayerId: 'a-2', type: 'LANGUAGE', name: 'Malayalam', expiryDate: null },
  ];
  const DOCUMENT_ROWS = [{ assayer_id: 'a-1', with_scan: 5, verified: 2, awaiting_verdict: 3 }];
  const EMPANELMENT_ROWS = [{ assayer_id: 'a-1', clients: 4, plannable: 2 }];

  async function buildService() {
    // One `manager.query` mock serving both grouped queries `hydrateDocumentSummaries` and
    // `hydrateEmpanelmentSummary` issue, told apart by which table their SQL names — the same
    // technique `roster-list-and-batch.spec.ts` uses for the single-query case.
    const query = jest.fn((sql: string) => {
      if (sql.includes('assayer_documents')) return Promise.resolve(DOCUMENT_ROWS);
      if (sql.includes('assayer_client_empanelments')) return Promise.resolve(EMPANELMENT_ROWS);
      return Promise.resolve([]);
    });
    const assayerRepo: any = {
      findAndCount: jest.fn(),
      find: jest.fn(),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query },
    };

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayerRepo },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue(WORKFORCE_ATTRS) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: {} },
        { provide: AuditService, useValue: { recordEvent: jest.fn(), recordEventSafe: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
        { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
        { provide: UnitOfWork, useValue: { run: (work: any) => work(undefined) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn() } },
      ],
    }).compile();

    return { service: mod.get<AssayerService>(AssayerService), assayerRepo, query };
  }

  const shapeOf = (row: any) => ({
    skills: row.skills,
    certifications: row.certifications,
    languages: row.languages,
    specializations: row.specializations,
    documents: row.documents,
    empanelment: row.empanelment,
  });

  it('gives the keyset/filtered path the same skills/documents/empanelment shape findAll produces', async () => {
    const { service, assayerRepo } = await buildService();

    // The reference: what an ordinary, unfiltered `findAll` page already looks like — hydrated
    // inline, the way it always has been.
    assayerRepo.findAndCount.mockResolvedValue([[{ id: 'a-1' }, { id: 'a-2' }], 2]);
    const { assayers: fromFindAll } = await service.findAll(1, 20);

    // The bug's own path: bare rows exactly as `RosterQueryService.findKeyset`/`findFiltered`
    // hand them back today — nothing hydrated — run through the fix.
    const fromRosterQuery = [{ id: 'a-1' }, { id: 'a-2' }] as any[];
    await service.hydrateRosterRows(fromRosterQuery);

    expect(fromRosterQuery.map(shapeOf)).toEqual(fromFindAll.map(shapeOf));

    // And pin the actual values, not only that the two paths agree with each other — a defect
    // shared by both call sites would still pass a bare equality check between them.
    expect((fromRosterQuery[0] as any).skills).toEqual(['Gold Assaying']);
    expect((fromRosterQuery[0] as any).certifications).toEqual([
      { name: 'BIS Hallmarking', expiryDate: '2027-06-01' },
    ]);
    expect((fromRosterQuery[0] as any).documents).toEqual({
      required: expect.any(Number), withScan: 5, verified: 2, awaitingVerdict: 3,
    });
    expect((fromRosterQuery[0] as any).empanelment).toEqual({ clientCount: 4, plannableClients: 2 });
    expect((fromRosterQuery[1] as any).skills).toEqual([]);
    expect((fromRosterQuery[1] as any).languages).toEqual(['Malayalam']);
    // Zeros, not an absent key — the emptiest case of the tally, not an exception to it.
    expect((fromRosterQuery[1] as any).documents).toEqual({
      required: expect.any(Number), withScan: 0, verified: 0, awaitingVerdict: 0,
    });
    expect((fromRosterQuery[1] as any).empanelment).toEqual({ clientCount: 0, plannableClients: 0 });
  });

  it('mutates and returns the same array it was given — the caller keeps its own reference', async () => {
    const { service } = await buildService();
    const rows = [{ id: 'a-1' }] as any[];
    const result = await service.hydrateRosterRows(rows);
    expect(result).toBe(rows);
  });

  it('costs a fixed number of grouped queries however many rows the page holds — no per-row loop', async () => {
    const { service, query } = await buildService();
    await service.hydrateRosterRows([{ id: 'a-1' }] as any[]);
    const forOne = query.mock.calls.length;

    query.mockClear();
    await service.hydrateRosterRows([{ id: 'a-1' }, { id: 'a-2' }, { id: 'a-3' }, { id: 'a-4' }] as any[]);
    expect(query.mock.calls.length).toBe(forOne);
  });

  it('asks nothing at all for an empty page', async () => {
    const { service, query } = await buildService();
    await service.hydrateRosterRows([]);
    expect(query).not.toHaveBeenCalled();
  });
});

// ── Part 2: both controller branches actually call the fix ───────────────────────────────────

/**
 * A behavioural test on `hydrateRosterRows` cannot see whether `AssayerController.findAll`
 * forgot to call it from one of its two `RosterQueryService` branches — which is exactly the
 * shape of bug this file exists to close: the keyset (`?after=`) and offset-filtered branches are
 * two independent call sites, and a fix landed in only one of them would leave the other still
 * returning undefined skills/documents/empanelment, silently. Static text analysis over the
 * controller's own source, not a NestJS test module — same technique
 * `assayer-controller-region-scope.spec.ts` uses for the same class of defect (a per-route fix
 * that must be re-applied to a sibling route by hand, with nothing failing when someone forgets).
 */
describe('roster hydration parity — AssayerController.findAll wires both branches to the fix', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'assayer.controller.ts'), 'utf8');
  // Comments blanked (character-for-character, so offsets stay usable), not stripped as lines —
  // this file's doc comments discuss the very identifiers this scan searches for.
  const content = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

  /**
   * The text of one method's own body, found by paren/brace depth rather than a naive `{`/`}`
   * search — a parameter's default value can open a brace of its own
   * (`new ParseLimitPipe({ default: 20 })`) that is not the method body's brace, which the naive
   * version would match instead. Same technique as `assayer-controller-region-scope.spec.ts`'s
   * `bodyEndAfter`, specialised to one named, known-unique method rather than every handler in
   * the file.
   */
  function methodBody(methodName: string): string {
    const marker = new RegExp(`\\basync ${methodName}\\(`);
    const match = marker.exec(content);
    if (!match) throw new Error(`Could not find "async ${methodName}(" in assayer.controller.ts`);

    const openParen = content.indexOf('(', match.index);
    let parenDepth = 0;
    let paramListEnd = openParen;
    for (; paramListEnd < content.length; paramListEnd++) {
      if (content[paramListEnd] === '(') parenDepth++;
      else if (content[paramListEnd] === ')') {
        parenDepth -= 1;
        if (parenDepth === 0) break;
      }
    }

    const openBrace = content.indexOf('{', paramListEnd + 1);
    let depth = 0;
    for (let i = openBrace; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth -= 1;
        if (depth === 0) return content.slice(openBrace, i + 1);
      }
    }
    throw new Error(`Unbalanced braces scanning ${methodName} in assayer.controller.ts`);
  }

  const body = methodBody('findAll');

  // The three read paths `findAll` dispatches to, in source order: keyset, then offset-filtered,
  // then the plain unfiltered path. Each `if`/branch computes its response and returns before the
  // next branch's code runs, so slicing the body BETWEEN consecutive call sites captures exactly
  // one branch's own text — without needing to match its enclosing braces at all.
  const keysetCallIdx = body.indexOf('rosterQuery.findKeyset');
  const filteredCallIdx = body.indexOf('rosterQuery.findFiltered');
  const plainCallIdx = body.indexOf('assayerService.findAll');

  // A canary for the scan itself: if the handler is restructured so these markers move or
  // disappear, this fails loudly instead of the assertions below silently checking nothing.
  it('finds all three read paths this handler dispatches to, in order', () => {
    expect(keysetCallIdx).toBeGreaterThan(-1);
    expect(filteredCallIdx).toBeGreaterThan(-1);
    expect(plainCallIdx).toBeGreaterThan(-1);
    expect(keysetCallIdx).toBeLessThan(filteredCallIdx);
    expect(filteredCallIdx).toBeLessThan(plainCallIdx);
  });

  it('the keyset branch (?after=) hydrates the rows RosterQueryService hands back', () => {
    const branch = body.slice(keysetCallIdx, filteredCallIdx);
    expect(branch).toMatch(/assayerService\.hydrateRosterRows/);
  });

  it('the offset-filtered branch hydrates the rows RosterQueryService hands back', () => {
    const branch = body.slice(filteredCallIdx, plainCallIdx);
    expect(branch).toMatch(/assayerService\.hydrateRosterRows/);
  });

  // The plain unfiltered path is deliberately not asserted to call `hydrateRosterRows` — it
  // hydrates through `AssayerService.findAll` itself, and the behavioural test above is what
  // proves that path's shape agrees with this one's.
});
