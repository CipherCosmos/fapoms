import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventCategory, SystemRole, OnboardingDocument, maskTail, looksMasked } from '@fapoms/shared';
import {
  AssayerService,
  SENSITIVE_ASSAYER_FIELDS,
  SENSITIVE_FIELD_NAMES,
  assertNoMaskedPii,
} from './assayer.service';
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
import { MASKED_IN_TRANSIT_FIELDS, scopeAssayerForRoles } from './assayer-visibility';
import { RosterRecordsService } from './roster-records.service';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * PAN, Aadhaar and bank account are encrypted at rest and were served in clear.
 *
 * The transformer on those columns decrypts on entity load, so a stolen backup was safe and a
 * logged-in ADMIN or OPERATIONS session was not: one `GET /assayers?limit=1000` returned every
 * appraiser's numbers whole, and nothing recorded that it had happened. These pin the three
 * halves of the fix — masked by default, one audited way to the real value, and no route by
 * which the mask can be written back over the number it is hiding.
 */
describe('sensitive assayer fields', () => {
  let service: AssayerService;
  let assayers: any;
  let audit: any;

  const ACTOR = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ops Manager', ipAddress: '10.0.0.9' };
  const ASSAYER_ID = '22222222-2222-4222-8222-222222222222';

  const NOT_NULL_COLUMNS = new Set(['address', 'city', 'district', 'state', 'employmentType']);

  beforeEach(async () => {
    assayers = {
      findOne: jest.fn(),
      save: jest.fn((row: any) => Promise.resolve(row)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn(),
      metadata: {
        findColumnWithPropertyName: (name: string) => ({
          propertyName: name,
          isNullable: !NOT_NULL_COLUMNS.has(name),
        }),
      },
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    audit = { recordEvent: jest.fn().mockResolvedValue({ id: 'ev-1' }), recordEventSafe: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn((r) => r), save: jest.fn() } },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

  // ── The vocabulary ────────────────────────────────────────────────────────

  /**
   * Two lists in two files, and they must describe the same three fields.
   *
   * If a field became revealable without being masked, the reveal route would be a second way to
   * read something already in clear on every list response — pointless, and it would make the
   * audit trail read as though the field were protected. If a field became masked with no way to
   * reveal it, HR would simply have lost access to a number they need, with no route to it and
   * nothing on screen saying why.
   */
  it('every revealable field is a masked field, and the other way round', () => {
    expect([...Object.values(SENSITIVE_ASSAYER_FIELDS)].sort())
      .toEqual([...MASKED_IN_TRANSIT_FIELDS].sort());
    expect(SENSITIVE_FIELD_NAMES).toEqual(['pan', 'aadhaar', 'bank']);
  });

  // ── Masked by default ─────────────────────────────────────────────────────

  it('serves the roles that may read these fields the last four digits, not the number', () => {
    const record = {
      id: ASSAYER_ID, assayerCode: 'AS0323', displayName: 'Soni Paragkumar M',
      panNumber: 'ABCDE1234F', aadhaarNumber: '999941057058', bankAccountNumber: '275201000000252',
    };
    for (const role of [SystemRole.ADMIN, SystemRole.OPERATIONS]) {
      const out = scopeAssayerForRoles(record, [role]) as any;
      expect(out.panNumber).toBe('******234F');
      expect(out.aadhaarNumber).toBe('********7058');
      expect(out.bankAccountNumber).toBe('***********0252');
      // The field NAMES do not change — every client already reads `panNumber`, and renaming it
      // would blank the roster table, the print profile and the mobile record at once.
      expect(Object.keys(out)).toEqual(expect.arrayContaining(MASKED_IN_TRANSIT_FIELDS));
    }
  });

  /**
   * "No PAN on file" is a fact HR chases; a row of stars would hide it, and the record-completeness
   * dimension of the qualification score counts exactly this.
   */
  it('leaves an absent number absent rather than inventing a mask for it', () => {
    const out = scopeAssayerForRoles(
      { id: ASSAYER_ID, assayerCode: 'AS0001', panNumber: null, bankAccountNumber: '' },
      [SystemRole.ADMIN],
    ) as any;
    expect(out.panNumber).toBeNull();
    expect(out.bankAccountNumber).toBe('');
  });

  // ── The reveal ────────────────────────────────────────────────────────────

  it.each([
    ['pan', 'panNumber', 'ABCDE1234F'],
    ['aadhaar', 'aadhaarNumber', '999941057058'],
    ['bank', 'bankAccountNumber', '275201000000252'],
  ])('reveals %s in full and writes exactly one audit event naming who, what and whose', async (
    field, property, value,
  ) => {
    assayers.findOne.mockResolvedValue({
      id: ASSAYER_ID, assayerCode: 'AS0323', displayName: 'Soni Paragkumar M', [property]: value,
    });

    const out = await service.revealSensitiveField(ASSAYER_ID, field, ACTOR);

    expect(out).toEqual({ value });
    expect(audit.recordEvent).toHaveBeenCalledTimes(1);
    const event = audit.recordEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      category: EventCategory.USER,
      eventType: 'ASSAYER_SENSITIVE_FIELD_REVEALED',
      entityType: 'ASSAYER',
      entityId: ASSAYER_ID,
      userId: ACTOR.id,
      ipAddress: ACTOR.ipAddress,
      metadata: { field, property, assayerCode: 'AS0323' },
    });
    expect(event.remarks).toContain('Soni Paragkumar M');
  });

  /**
   * The trail must not become a second copy of the thing it is protecting: `audit_events` is
   * readable by roles that cannot read the column the value came out of.
   */
  it('never puts the revealed value into the audit row', async () => {
    assayers.findOne.mockResolvedValue({ id: ASSAYER_ID, assayerCode: 'AS0323', panNumber: 'ABCDE1234F' });
    await service.revealSensitiveField(ASSAYER_ID, 'pan', ACTOR);
    expect(JSON.stringify(audit.recordEvent.mock.calls[0][0])).not.toContain('ABCDE1234F');
  });

  /**
   * A reveal that is not recorded is the event this endpoint exists to prevent, so the audit
   * write is awaited BEFORE the value is returned and a failure fails the read. That is the
   * opposite of the rule everywhere else in this service, where a completed state change must
   * not be undone by a failed trail entry — here there is no state change to protect.
   */
  it('withholds the value when the audit write fails', async () => {
    assayers.findOne.mockResolvedValue({ id: ASSAYER_ID, assayerCode: 'AS0323', panNumber: 'ABCDE1234F' });
    audit.recordEvent.mockRejectedValue(new Error('audit_events unreachable'));

    await expect(service.revealSensitiveField(ASSAYER_ID, 'pan', ACTOR)).rejects.toThrow('audit_events unreachable');
  });

  /**
   * A 500 that happens for some path segments and not others tells an attacker which columns
   * exist. This is the caller's mistake and says so, and it names the three legal values.
   */
  it('refuses an unknown field with 400, and lists the ones that are real', async () => {
    await expect(service.revealSensitiveField(ASSAYER_ID, 'passwordHash', ACTOR))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.revealSensitiveField(ASSAYER_ID, 'salary', ACTOR))
      .rejects.toThrow(/pan, aadhaar, bank/);
    // Nothing is read and nothing is recorded for a request that never named a real field.
    expect(assayers.findOne).not.toHaveBeenCalled();
    expect(audit.recordEvent).not.toHaveBeenCalled();
  });

  /** `hasOwnProperty`, not `in` — otherwise 'constructor' and 'toString' name a field. */
  it('does not treat an inherited Object property as a field name', async () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      await expect(service.revealSensitiveField(ASSAYER_ID, name, ACTOR))
        .rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('404s for an assayer that does not exist, without recording a reveal', async () => {
    assayers.findOne.mockResolvedValue(null);
    await expect(service.revealSensitiveField(ASSAYER_ID, 'pan', ACTOR))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(audit.recordEvent).not.toHaveBeenCalled();
  });

  /**
   * Reads through the repository so the `encryptedColumn` transformer decrypts. A raw query here
   * would hand back the `enc:v1:` ciphertext and look like it had worked.
   */
  it('reads through the repository rather than raw SQL, so the value is decrypted', async () => {
    assayers.findOne.mockResolvedValue({ id: ASSAYER_ID, assayerCode: 'AS0323', panNumber: 'ABCDE1234F' });
    await service.revealSensitiveField(ASSAYER_ID, 'pan', ACTOR);

    expect(assayers.manager.query).not.toHaveBeenCalled();
    expect(assayers.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ASSAYER_ID } }),
    );
  });

  it('answers "nothing on file" with an empty string rather than null', async () => {
    assayers.findOne.mockResolvedValue({ id: ASSAYER_ID, assayerCode: 'AS0323', panNumber: null });
    await expect(service.revealSensitiveField(ASSAYER_ID, 'pan', ACTOR)).resolves.toEqual({ value: '' });
  });

  // ── The masked value must never be written back ───────────────────────────

  /**
   * The round trip: reads are masked, and the web edit form posts the keys it thinks changed.
   * Without this the save replaces an encrypted PAN with six asterisks and four digits, and
   * there is no copy of the original anywhere to restore from.
   */
  it.each(MASKED_IN_TRANSIT_FIELDS)('refuses %s carrying a masked value, and says how to fix it', (property) => {
    const masked = maskTail(property === 'aadhaarNumber' ? '999941057058' : 'ABCDE1234F');
    expect(() => assertNoMaskedPii({ [property]: masked })).toThrow(BadRequestException);
    expect(() => assertNoMaskedPii({ [property]: masked })).toThrow(/Reveal the field first/);
  });

  /**
   * `bankAccountNumber` is the field that matters most here and the one the DTO layer could
   * never cover: a bank account number has no checkable shape, so there is no format rule to
   * catch a mask on the way past. It is also the field a payroll-diversion attempt aims at.
   */
  it('catches a masked bank account, which no format rule can', () => {
    expect(() => assertNoMaskedPii({ bankAccountNumber: '***********0252' })).toThrow(BadRequestException);
  });

  it('lets a real value, an empty value and an untouched body through', () => {
    expect(() => assertNoMaskedPii({
      panNumber: 'ABCDE1234F', aadhaarNumber: '999941057058', bankAccountNumber: '275201000000252',
    })).not.toThrow();
    // Clearing a field is a legitimate edit — see the empty-string rule on the request DTOs.
    expect(() => assertNoMaskedPii({ panNumber: '', bankAccountNumber: null })).not.toThrow();
    expect(() => assertNoMaskedPii({ city: 'Pune' })).not.toThrow();
    expect(() => assertNoMaskedPii(undefined)).not.toThrow();
  });

  it('guards the update path itself, ahead of the copy loop that writes the columns', async () => {
    await expect(service.update(ASSAYER_ID, { bankAccountNumber: '***********0252' } as any, ACTOR.id))
      .rejects.toBeInstanceOf(BadRequestException);
    // Refused before anything was even loaded, let alone saved.
    expect(assayers.save).not.toHaveBeenCalled();
  });

  it('guards the create path too', async () => {
    await expect(service.create(
      { firstName: 'A', lastName: 'B', state: 'Maharashtra', panNumber: '******234F' } as any,
      ACTOR.id,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(assayers.save).not.toHaveBeenCalled();
  });

  /** The detector is "contains an asterisk", because no real identifier ever does. */
  it('recognises a mask however it was trimmed or re-padded on the way round', () => {
    expect(looksMasked('******234F')).toBe(true);
    expect(looksMasked('*234F')).toBe(true);
    expect(looksMasked('****')).toBe(true);
    expect(looksMasked('ABCDE1234F')).toBe(false);
    expect(looksMasked('')).toBe(false);
    expect(looksMasked(null)).toBe(false);
  });
});

/**
 * The dossier is the one read the response-boundary interceptor structurally cannot mask: it
 * identifies assayers by `assayerCode`, and a document checklist row carries a document id and a
 * requirement, not a person's code. The same reasoning already restricts this endpoint to
 * ADMIN/OPERATIONS. So the masking is applied where the value is assembled.
 */
describe('the dossier paperwork checklist', () => {
  let service: RosterRecordsService;
  let assayers: any;
  let onboarding: any;

  const ASSAYER_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    assayers = {
      findOne: jest.fn().mockResolvedValue({
        id: ASSAYER_ID,
        panNumber: 'ABCDE1234F',
        aadhaarNumber: '999941057058',
      }),
      save: jest.fn((r: any) => Promise.resolve(r)),
    };
    onboarding = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((r: any) => ({ ...r, filePaths: [] })),
      save: jest.fn((r: any) => Promise.resolve(r)),
    };

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
  });

  it('masks the number a clerk works the paperwork from, whichever table it lives in', async () => {
    onboarding.find.mockResolvedValue([
      // PASSPORT keeps its number on the document row; PAN reads back off the person.
      { requirement: OnboardingDocument.PASSPORT, id: 'd-1', documentNumber: 'Z1234567', filePaths: [] },
    ]);

    const { onboarding: checklist } = await service.dossier(ASSAYER_ID);
    const at = (r: OnboardingDocument) => checklist.find((c: any) => c.requirement === r);

    expect(at(OnboardingDocument.PAN_CARD)!.documentNumber).toBe('******234F');
    expect(at(OnboardingDocument.AADHAAR_FRONT)!.documentNumber).toBe('********7058');
    expect(at(OnboardingDocument.PASSPORT)!.documentNumber).toBe('****4567');
  });

  it('keeps "no document number on file" distinguishable from a masked one', async () => {
    assayers.findOne.mockResolvedValue({ id: ASSAYER_ID, panNumber: null, aadhaarNumber: null });

    const { onboarding: checklist } = await service.dossier(ASSAYER_ID);
    expect(checklist.find((c: any) => c.requirement === OnboardingDocument.PAN_CARD)!.documentNumber).toBeNull();
  });

  /**
   * This write path reaches THROUGH to `assayers.pan_number` for the three requirements whose
   * number lives on the person, so a masked round trip here overwrites the real PAN from the
   * paperwork screen — one step further from anywhere anybody would think to look for it.
   */
  it('refuses a masked document number rather than writing it onto the person', async () => {
    await expect(service.setDocument(
      ASSAYER_ID, OnboardingDocument.PAN_CARD, { documentNumber: '******234F' }, 'user-1',
    )).rejects.toThrow(/Reveal the field first/);
    expect(assayers.save).not.toHaveBeenCalled();
    expect(onboarding.save).not.toHaveBeenCalled();
  });

  it('still accepts a real document number', async () => {
    await service.setDocument(ASSAYER_ID, OnboardingDocument.PAN_CARD, { documentNumber: 'ABCDE1234F' }, 'user-1');
    expect(assayers.save).toHaveBeenCalledWith(expect.objectContaining({ panNumber: 'ABCDE1234F' }));
  });

  /**
   * The three identity documents the roster spreadsheet has no column for.
   *
   * `ONBOARDING_DOCUMENT_COLUMNS` maps them to `''` because they came from the identity register,
   * not the roster file. `setDocument` tested that mapped VALUE for truthiness, so all three read
   * as unknown requirements and every `PUT` against them was refused — while `attachFile` accepted
   * a scan for them quite happily. A clerk could file a passport and then record nothing at all
   * about the document they had just filed.
   */
  it.each([OnboardingDocument.DRIVING_LICENCE, OnboardingDocument.VOTER_ID, OnboardingDocument.PASSPORT])(
    'accepts %s, which has no spreadsheet column but is still a real requirement',
    async (requirement) => {
      await expect(service.setDocument(ASSAYER_ID, requirement, { documentNumber: 'X1234567' }, 'user-1'))
        .resolves.toBeDefined();
      await expect(service.attachFile(ASSAYER_ID, requirement, 'scans/x.pdf', 'user-1'))
        .resolves.toBeDefined();
      // Their number has no column on the person, so it stays on the document row.
      expect(onboarding.save).toHaveBeenCalledWith(expect.objectContaining({ documentNumber: 'X1234567' }));
    },
  );

  /**
   * `attachFile` validated nothing, so any string created a document row — which is how a typo or
   * a renamed enum value grows a parallel set of rows that no checklist counts and no queue shows.
   */
  it.each(['setDocument', 'attachFile'] as const)('refuses a requirement it does not know, on %s', async (method) => {
    const call = method === 'setDocument'
      ? service.setDocument(ASSAYER_ID, 'NOT_A_REQUIREMENT' as OnboardingDocument, {}, 'user-1')
      : service.attachFile(ASSAYER_ID, 'NOT_A_REQUIREMENT' as OnboardingDocument, 'scans/x.pdf', 'user-1');

    await expect(call).rejects.toThrow(/not a paperwork requirement this system knows/);
    expect(onboarding.save).not.toHaveBeenCalled();
  });

  /** Inherited Object properties are not requirement names. */
  it('does not accept an inherited Object property as a requirement', async () => {
    for (const name of ['constructor', 'toString']) {
      await expect(service.attachFile(ASSAYER_ID, name as OnboardingDocument, 'scans/x.pdf', 'user-1'))
        .rejects.toThrow(/not a paperwork requirement/);
    }
  });
});
