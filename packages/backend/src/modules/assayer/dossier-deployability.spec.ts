import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  AssayerLifecycleStatus, EmpanelmentStatus, OnboardingDocument, DocumentVerification,
  AssayerUnavailableReason, PLACEHOLDER_PIN_METRES,
} from '@fapoms/shared';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { RosterRecordsService } from './roster-records.service';
import { AssayerEntity } from './assayer.entity';
import { AssayerReferenceEntity } from './assayer-reference.entity';
import { AssayerClientEmpanelmentEntity } from './assayer-client-empanelment.entity';
import { AssayerBackgroundCheckEntity } from './assayer-background-check.entity';
import { AssayerDocumentEntity } from './assayer-document.entity';
import { AssayerImportIssueEntity } from './assayer-import-issue.entity';

/**
 * THE DOSSIER HAS TO ANSWER "MAY WE SEND THIS PERSON OUT", BECAUSE THE CARD SAYS IT DOES.
 *
 * `DeploymentReadinessCard` is labelled "(Backend-Authoritative)" and branches on
 * `dossier.deployable` / `dossier.deploymentBlockers`. This endpoint returned six keys and neither
 * of those, so both read `undefined`, the verdict collapsed to the card's own three-item list
 * (lifecycle, an explicit `unavailableReason`, a missing coordinate) and everything else it
 * displayed — unverified identity documents, no bank account, no IFSC, no PAN, zero plannable
 * empanelments — was demoted to a *warning* that does not touch the badge.
 *
 * The case that was reproduced in the browser is the last test in this file, and it is the reason
 * for the rest: an ACTIVE person with a coordinate, no payout details, no verified identity and
 * ZERO empanelments rendered a green **Deployable** badge, while the planner refused the same
 * person with "planning requires an Active or Recommended empanelment standing". The card and the
 * dispatch surface disagreed about one person, out loud, on the same screen a coordinator uses to
 * decide whether to ring them.
 *
 * These fixtures are a table rather than prose because the value of the verdict is that it holds
 * across every state, not that it happens to be right for the happy path. Each row names the gate
 * it is standing in for; if a gate moves, a row here should move with it or the two have drifted.
 */
describe('RosterRecordsService.dossier — deployability is the server\'s answer', () => {
  let service: RosterRecordsService;
  let assayers: any;
  let empanelments: any;
  let onboarding: any;
  /**
   * The identity gate's own setting, because the verdict answers to it.
   *
   * An unverified identity is only a BLOCKER when `onboarding.identityGate.mode` is `enforce` —
   * the setting that actually refuses an activation in `doTransitionLifecycle`. It ships as
   * `warn`, and on this deployment not one of 11,160 document rows is verified, so treating it
   * as a blocker regardless would paint all 540 ACTIVE appraisers "Blocked from Deployment"
   * while the planner went on dispatching every one of them. The tests below therefore state
   * which mode they are standing in.
   */
  let identityGateMode: string;

  /** A person who clears every gate: ACTIVE, empanelled, identified, pinned, payable. */
  const deployablePerson = (over: Record<string, unknown> = {}) => ({
    id: 'asr-1',
    assayerCode: 'DRFIX-0001',
    displayName: 'Ramesh Kumar',
    isActive: true,
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    unavailableReason: null,
    exitDate: null,
    terminationDate: null,
    // Every critical record field the payout rule and the distance pre-filter read.
    phone: '+919000000000',
    panNumber: 'ABCDE1234F',
    bankAccountNumber: '000111222333',
    ifscCode: 'HDFC0000001',
    joiningDate: '2024-01-01',
    emergencyContactPhone: '+919000000001',
    latitude: 9.931233,
    longitude: 76.267303,
    // Metres, not the 100 km state centroid `isPlaceholderPin` catches.
    geoAccuracyMeters: 30,
    ...over,
  });

  /** An empanelment row as the dossier query returns it — `is_active = true`, client joined. */
  const standing = (status: EmpanelmentStatus, clientCode = 'HDFC') => ({
    id: `emp-${status}-${clientCode}`,
    assayerId: 'asr-1',
    status,
    client: { id: 'cl-1', name: `${clientCode} Bank`, clientCode },
  });

  /**
   * A verified identity document, WITH a file behind it.
   *
   * Both halves are load-bearing and `identityStanding` says why: the roster import wrote 11,160
   * rows asserting a document had arrived with no file behind any of them, so a fixture that sets
   * only `verificationStatus` would prove the gate passes people it must refuse.
   */
  const verifiedDoc = (requirement: OnboardingDocument) => ({
    id: `doc-${requirement}`,
    assayerId: 'asr-1',
    requirement,
    isActive: true,
    verificationStatus: DocumentVerification.VERIFIED,
    filePaths: [`s3://scans/${requirement}.jpg`],
  });

  const verifiedIdentity = () => [
    verifiedDoc(OnboardingDocument.AADHAAR_FRONT),
    verifiedDoc(OnboardingDocument.PAN_CARD),
  ];

  /** Serves one person, their standings and their paperwork; everything else is empty. */
  const serve = (opts: {
    person?: Record<string, unknown>;
    empanelments?: unknown[];
    documents?: unknown[];
  } = {}) => {
    assayers.findOne.mockResolvedValue(opts.person ?? deployablePerson());
    empanelments.find.mockResolvedValue(opts.empanelments ?? [standing(EmpanelmentStatus.ACTIVE)]);
    onboarding.find.mockResolvedValue(opts.documents ?? verifiedIdentity());
  };

  beforeEach(async () => {
    assayers = { findOne: jest.fn() };
    empanelments = { find: jest.fn() };
    onboarding = { find: jest.fn() };
    identityGateMode = 'enforce';

    const mod = await Test.createTestingModule({
      providers: [
        RosterRecordsService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerReferenceEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerClientEmpanelmentEntity), useValue: empanelments },
        { provide: getRepositoryToken(AssayerBackgroundCheckEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerDocumentEntity), useValue: onboarding },
        { provide: getRepositoryToken(AssayerImportIssueEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: PlatformSettingsService, useValue: { get: jest.fn(async () => identityGateMode) } },
      ],
    }).compile();
    service = mod.get(RosterRecordsService);
  });

  /**
   * The contract itself. The card reads two named keys; a payload that omits them leaves it
   * branching on `undefined`, which is how the whole defect worked — `undefined` is falsy for the
   * blocker list and falsy for the verdict, and the card's fallback turned both into "fine".
   */
  it('emits deployable and deploymentBlockers as actual keys, not as absences', async () => {
    serve();
    const dossier: any = await service.dossier('asr-1');

    expect(Object.keys(dossier)).toEqual(expect.arrayContaining(['deployable', 'deploymentBlockers']));
    expect(typeof dossier.deployable).toBe('boolean');
    expect(Array.isArray(dossier.deploymentBlockers)).toBe(true);
  });

  it('keeps the six keys the dossier already served — this is an addition, not a reshape', async () => {
    serve();
    const dossier: any = await service.dossier('asr-1');

    expect(Object.keys(dossier)).toEqual(expect.arrayContaining([
      'references', 'empanelments', 'backgroundChecks', 'currentCheck', 'onboarding', 'openIssues',
    ]));
  });

  it('says yes, with nothing to report, for somebody who clears every gate', async () => {
    serve();
    const dossier: any = await service.dossier('asr-1');

    expect(dossier.deploymentBlockers).toEqual([]);
    expect(dossier.deployable).toBe(true);
  });

  /**
   * ONE ROW PER GATE.
   *
   * `expect` is a fragment rather than the whole sentence on purpose: the wording is meant to be
   * edited as the desk learns what actually helps, and a test pinning it character-for-character
   * would make that edit look like a regression. What must not change is that the blocker names
   * the thing that is wrong and the screen the fix lives on.
   */
  const cases: Array<{
    name: string;
    gate: string;
    person?: Record<string, unknown>;
    empanelments?: unknown[];
    documents?: unknown[];
    expect: RegExp;
  }> = [
    // ── The lifecycle gate: the candidate-pool query and DeployabilityFilter both demand
    // `status = ACTIVE`, and `status` is operationalStatusFor(lifecycleStatus). Every value below
    // therefore projects to something other than ACTIVE and is refused by the planner, by
    // accepting an offer, and by check-in.
    {
      name: 'INVITED',
      gate: 'DeployabilityFilter.explain — the planner\'s own next-step sentence',
      person: { lifecycleStatus: AssayerLifecycleStatus.INVITED },
      expect: /onboarding not finished: invited — start document verification on the HR roster/,
    },
    {
      name: 'DOCUMENT_VERIFICATION',
      gate: 'DeployabilityFilter.explain',
      person: { lifecycleStatus: AssayerLifecycleStatus.DOCUMENT_VERIFICATION },
      expect: /onboarding not finished: in document verification — complete it on the HR roster/,
    },
    {
      name: 'BACKGROUND_VERIFICATION',
      gate: 'DeployabilityFilter.explain',
      person: { lifecycleStatus: AssayerLifecycleStatus.BACKGROUND_VERIFICATION },
      expect: /onboarding not finished: in background verification/,
    },
    {
      name: 'TRAINING',
      gate: 'DeployabilityFilter.explain',
      person: { lifecycleStatus: AssayerLifecycleStatus.TRAINING },
      expect: /onboarding not finished: in training — mark training complete on the HR roster to activate/,
    },
    {
      name: 'ON_LEAVE',
      gate: 'operationalStatusFor maps ON_LEAVE to INACTIVE deliberately',
      person: { lifecycleStatus: AssayerLifecycleStatus.ON_LEAVE },
      expect: /on leave — .*candidate pool/,
    },
    {
      name: 'SUSPENDED',
      gate: 'the accept guard and the check-in guard, both status !== ACTIVE',
      person: { lifecycleStatus: AssayerLifecycleStatus.SUSPENDED },
      expect: /suspended — no assignment is offered, accepted or checked in/,
    },
    {
      name: 'INACTIVE',
      gate: 'operationalStatusFor',
      person: { lifecycleStatus: AssayerLifecycleStatus.INACTIVE },
      expect: /parked as inactive — move them back to Active on the HR roster/,
    },
    {
      name: 'RESIGNED',
      gate: 'hasLeftWorkforce + the rehire edge, which restarts at Invited',
      person: { lifecycleStatus: AssayerLifecycleStatus.RESIGNED },
      expect: /off the workforce \(Resigned\) — a rehire restarts onboarding from Invited/,
    },
    {
      name: 'TERMINATED',
      gate: 'hasLeftWorkforce',
      person: { lifecycleStatus: AssayerLifecycleStatus.TERMINATED },
      expect: /off the workforce \(Terminated\)/,
    },
    {
      name: 'ARCHIVED',
      gate: 'hasLeftWorkforce; ARCHIVED is terminal',
      person: { lifecycleStatus: AssayerLifecycleStatus.ARCHIVED },
      expect: /off the workforce \(Archived\)/,
    },
    {
      // A death is not a lifecycle value — it is INACTIVE carrying `unavailableReason = DECEASED`,
      // which is the case `hasLeftWorkforce` exists for and the one a lifecycle-only reading of
      // this record gets wrong.
      name: 'INACTIVE + DECEASED',
      gate: 'hasLeftWorkforce\'s awkward case',
      person: {
        lifecycleStatus: AssayerLifecycleStatus.INACTIVE,
        unavailableReason: AssayerUnavailableReason.DECEASED,
      },
      expect: /recorded as deceased — the record is kept for audit history/,
    },

    // ── Soft delete: DeployabilityFilter refuses `!isActive` before it will even look at the
    // administrator's onboarding bypass, and the pool query never selects the row.
    {
      name: 'deleted profile',
      gate: 'DeployabilityFilter — never selectable, bypass or not',
      person: { isActive: false },
      expect: /profile has been deleted from the workforce — restore it on the HR roster/,
    },

    // ── An explicit unavailability on somebody the lifecycle still calls ACTIVE.
    {
      name: 'ACTIVE + unavailableReason',
      gate: 'the roster\'s own availability column',
      person: { unavailableReason: AssayerUnavailableReason.NO_WORK_IN_AREA },
      expect: /marked unavailable \(NO_WORK_IN_AREA\) — clear the unavailability on the HR roster/,
    },

    // ── stillWorkable, which is stricter than every dispatch gate: an exit date filed while
    // nobody moved the lifecycle leaves `status` reading ACTIVE, so the planner would offer this
    // person work.
    {
      name: 'ACTIVE + an exit date nobody acted on',
      gate: 'stillWorkable — the mirror-image record',
      person: { exitDate: new Date('2026-03-31T00:00:00Z') },
      expect: /recorded as having left on 2026-03-31 while the lifecycle still reads Active/,
    },

    // ── The per-client empanelment gate, asked of every client at once.
    {
      name: 'ACTIVE + zero empanelments',
      gate: 'ClientEligibilityFilter under noEmpanelmentRow=BLOCK',
      empanelments: [],
      expect: /no client empanelment on file — record an Active or Recommended standing on the vetting screen/,
    },
    {
      // DOCUMENTS_PENDING is not a refusal, and it still does not qualify. This is exactly the
      // reading a screen inventing its own "blocking standings" list gets wrong.
      name: 'ACTIVE + only DOCUMENTS_PENDING',
      gate: 'standingAllowsPlanning is narrower than the enum looks',
      empanelments: [standing(EmpanelmentStatus.DOCUMENTS_PENDING, 'AXIS')],
      expect: /no client empanelment in a plannable standing — DOCUMENTS_PENDING with AXIS on file/,
    },
    {
      name: 'ACTIVE + only INACTIVE (dormant) standings',
      gate: 'standingAllowsPlanning',
      empanelments: [standing(EmpanelmentStatus.INACTIVE, 'SBI')],
      expect: /only Active or Recommended lets the planner offer work/,
    },
    {
      name: 'ACTIVE + only REJECTED standings',
      gate: 'the strictly-non-overridable arm of the assignment gate',
      empanelments: [standing(EmpanelmentStatus.REJECTED, 'ICICI')],
      expect: /REJECTED with ICICI on file/,
    },

    // ── The identity gate: the same documents and the same words the activation gate uses.
    {
      name: 'ACTIVE + no identity documents at all',
      gate: 'identityStanding / IDENTITY_GATE_DOCUMENTS',
      documents: [],
      expect: /identity not established — Aadhaar — front and PAN card have not been checked against the original/,
    },
    {
      // A row asserting the document arrived, with no file behind it. 11,160 such rows were
      // imported; counting rows would report this estate as fully documented.
      name: 'ACTIVE + a verified row with no scan behind it',
      gate: 'identityStanding\'s "a scan exists AND somebody attested to it"',
      documents: [
        { ...verifiedDoc(OnboardingDocument.AADHAAR_FRONT), filePaths: [] },
        verifiedDoc(OnboardingDocument.PAN_CARD),
      ],
      expect: /identity not established — Aadhaar — front has not been checked against the original/,
    },
    {
      name: 'ACTIVE + a document that was sent back',
      gate: 'identityStanding — refused is not the same instruction as missing',
      documents: [
        verifiedDoc(OnboardingDocument.AADHAAR_FRONT),
        { ...verifiedDoc(OnboardingDocument.PAN_CARD), verificationStatus: DocumentVerification.REJECTED },
      ],
      expect: /PAN card was sent back and has not been replaced/,
    },

    // ── The home pin. Missing is silent in the planner; a centroid is worse than silent.
    {
      name: 'ACTIVE + no coordinate',
      gate: 'the candidate distance pre-filter, which drops the unplaceable with no reason',
      person: { latitude: null, longitude: null, geoAccuracyMeters: null },
      expect: /no home location recorded — .*drops anyone it cannot place, silently/,
    },
    {
      name: 'ACTIVE + a state-centroid pin',
      gate: 'isPlaceholderPin / PLACEHOLDER_PIN_METRES',
      person: { geoAccuracyMeters: PLACEHOLDER_PIN_METRES },
      expect: /home pin is a placeholder, not a home/,
    },

    // ── Payability. This one does not stop a dispatch, and the sentence says so.
    {
      name: 'ACTIVE + missing payout details',
      gate: 'cannotBePaid / payoutBlockingGaps',
      person: { bankAccountNumber: null, ifscCode: null, panNumber: null },
      expect: /payout details incomplete \(PAN, Bank account, IFSC\) — the audit can be dispatched, but every payable it earns is held/,
    },
    {
      name: 'ACTIVE + only the bank account missing',
      gate: 'payoutBlockingGaps names the gap, not "payment details"',
      person: { bankAccountNumber: null },
      expect: /payout details incomplete \(Bank account\)/,
    },
  ];

  it.each(cases)('blocks $name — $gate', async ({ person, empanelments: emps, documents, expect: pattern }) => {
    serve({
      person: person ? deployablePerson(person) : undefined,
      empanelments: emps,
      documents,
    });

    const dossier: any = await service.dossier('asr-1');

    expect(dossier.deployable).toBe(false);
    expect(dossier.deploymentBlockers).toEqual(
      expect.arrayContaining([expect.stringMatching(pattern)]),
    );
  });

  /**
   * A departure must read as ONE problem.
   *
   * DECEASED is filed as an unavailability, so the naive composition names it twice — once as a
   * departure and once as an unavailable reason — and a two-item list reads as two things to go
   * and fix, one of which is not a thing anybody can fix.
   */
  it('does not report a death twice under two different headings', async () => {
    serve({
      person: deployablePerson({
        lifecycleStatus: AssayerLifecycleStatus.INACTIVE,
        unavailableReason: AssayerUnavailableReason.DECEASED,
      }),
    });

    const dossier: any = await service.dossier('asr-1');
    expect(dossier.deploymentBlockers.filter((b: string) => /deceased|unavailable/i.test(b))).toHaveLength(1);
  });

  /**
   * THE ACCEPTANCE CASE, exactly as reproduced in the browser.
   *
   * ACTIVE, pinned, payable-in-every-other-respect — and with no bank account, no verified
   * identity document and no empanelment anywhere. The card drew this person green. The planner
   * refused them outright. All three reasons must now come back from the server, because the card
   * has nothing else to draw from and no business inventing a rulebook of its own.
   */
  it('refuses the browser-reproduced record — ACTIVE, no bank, no verified identity, no empanelment', async () => {
    serve({
      person: deployablePerson({ bankAccountNumber: null }),
      empanelments: [],
      documents: [],
    });

    const dossier: any = await service.dossier('asr-1');

    expect(dossier.deployable).toBe(false);
    expect(dossier.deploymentBlockers).toHaveLength(3);
    expect(dossier.deploymentBlockers).toEqual(expect.arrayContaining([
      expect.stringMatching(/no client empanelment on file/),
      expect.stringMatching(/identity not established/),
      expect.stringMatching(/payout details incomplete \(Bank account\)/),
    ]));
    // And not one of them is about the lifecycle: this person really is ACTIVE, which is the
    // whole reason the card believed them fine.
    expect(dossier.deploymentBlockers.join(' ')).not.toMatch(/onboarding not finished|suspended|on leave/);
  });

  /**
   * The identity question has one implementation with two entry points, so that this endpoint and
   * the activation gate can never come to different conclusions about the same documents.
   */
  it('agrees with identityStanding, the gate that decides whether somebody may be activated at all', async () => {
    const documents = [
      verifiedDoc(OnboardingDocument.AADHAAR_FRONT),
      { ...verifiedDoc(OnboardingDocument.PAN_CARD), verificationStatus: DocumentVerification.REJECTED },
    ];
    serve({ documents });

    const [dossier, gate] = await Promise.all([
      service.dossier('asr-1') as any,
      service.identityStanding('asr-1'),
    ]);

    expect(gate.ok).toBe(false);
    expect(gate.rejected).toEqual([OnboardingDocument.PAN_CARD]);
    expect(dossier.deploymentBlockers.some((b: string) => /identity not established/.test(b))).toBe(true);
  });

  /**
   * THE IDENTITY BLOCKER TRACKS THE SETTING THAT WOULD ACTUALLY REFUSE THE ACTIVATION.
   *
   * This is the one gate on the card whose strictness is configurable, and getting it wrong is
   * how a readiness screen becomes noise. Measured on the live roster: 0 of 11,160 document rows
   * are verified and 0 have a file, so an unconditional identity blocker marks every one of the
   * 540 ACTIVE appraisers as blocked — while no dispatch path consults identity at all and the
   * planner sends them out regardless. The card would be both useless and, on its own terms,
   * wrong: it claims to say what the backend will refuse, and the backend refuses none of them.
   *
   * `warn` is the shipped default and means "record the gap, do not stop anyone". `enforce` is
   * the position where `doTransitionLifecycle` genuinely refuses an activation — and only then
   * does the card say blocked.
   */
  describe('the identity gate\'s mode decides whether identity blocks', () => {
    const unverified = () => {
      assayers.findOne.mockResolvedValue(deployablePerson());
      empanelments.find.mockResolvedValue([{ status: EmpanelmentStatus.ACTIVE, client: { clientCode: 'AXIS' } }]);
      onboarding.find.mockResolvedValue([]);
    };

    it('does not block on an unverified identity while the gate is set to warn', async () => {
      identityGateMode = 'warn';
      unverified();
      const d: any = await service.dossier('asr-1');
      expect(d.deploymentBlockers.filter((b: string) => /identity/i.test(b))).toEqual([]);
      expect(d.deployable).toBe(true);
    });

    it('does not block on an unverified identity while the gate is off', async () => {
      identityGateMode = 'off';
      unverified();
      const d: any = await service.dossier('asr-1');
      expect(d.deploymentBlockers.filter((b: string) => /identity/i.test(b))).toEqual([]);
      expect(d.deployable).toBe(true);
    });

    it('blocks on an unverified identity the moment the gate is set to enforce', async () => {
      identityGateMode = 'enforce';
      unverified();
      const d: any = await service.dossier('asr-1');
      expect(d.deploymentBlockers).toContainEqual(expect.stringMatching(/identity not established/));
      expect(d.deployable).toBe(false);
    });

    /**
     * The gate's mode changes nothing else. A person blocked for a reason that has nothing to do
     * with identity stays blocked under every mode — otherwise "the gate is off" would quietly
     * become "the card is off".
     */
    it('leaves every other blocker alone whatever the mode', async () => {
      for (const mode of ['off', 'warn', 'enforce']) {
        identityGateMode = mode;
        assayers.findOne.mockResolvedValue(deployablePerson({ bankAccountNumber: null, ifscCode: null }));
        empanelments.find.mockResolvedValue([{ status: EmpanelmentStatus.ACTIVE, client: { clientCode: 'AXIS' } }]);
        onboarding.find.mockResolvedValue([]);
        const d: any = await service.dossier('asr-1');
        expect(d.deployable).toBe(false);
        expect(d.deploymentBlockers.some((b: string) => /bank|ifsc|paid/i.test(b))).toBe(true);
      }
    });
  });
});
