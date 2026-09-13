import { BadRequestException } from '@nestjs/common';
import { ApplicationStatus, InterviewOutcome, SystemRole } from '@fapoms/shared';

import { AssayerInterviewService } from './assayer-interview.service';
import { runWithRequestContext } from '../../core/context/request-context';

/**
 * The interview gate — the Appraiser Recruitment spec's Module 1.
 *
 * Its entire job is to decide who gets a self-registration link, so the rule that matters is the
 * negative one: a FAIL must spawn nothing. An invite sent to somebody the company just turned down
 * is not a cosmetic bug — it invites them to upload their Aadhaar and PAN to a company that has
 * already decided against them.
 */
describe('interview outcomes', () => {
  const setup = () => {
    const saved: Record<string, any>[] = [];
    const save = async (_entity: unknown, v: Record<string, any>) => {
      const row = { ...v, id: v.id ?? 'interview-1' };
      saved.push(row);
      // The service mutates and re-saves the same object to record the spawned application.
      Object.assign(v, { id: row.id });
      return v;
    };
    const interviews = {
      create: jest.fn((v: Record<string, any>) => ({ ...v })),
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
    };
    const registrationApplications = {
      openApplicationForMobile: jest.fn(async () => null),
      createInviteRecord: jest.fn(async (_input: Record<string, any>) =>
        ({ application: { id: 'app-1' }, rawToken: 'raw' })),
      deliverInvite: jest.fn(async () => ({ emailed: true, inviteLink: 'https://x/register/raw' })),
      resendInvite: jest.fn(async () => ({ emailed: true, inviteLink: 'https://x/register/fresh' })),
      findApplicationForAmend: jest.fn(async () => null),
    };
    /*
      The transaction is the harness's own, because the rule under test is what happens INSIDE it:
      the interview, the application and the link between them are one write, and the email is
      sent only after it returns.
    */
    const unitOfWork = { run: jest.fn(async (work: any) => work({ save: jest.fn(save) })) };
    const auditService = { recordEventSafe: jest.fn(async () => undefined) };
    const service = new AssayerInterviewService(
      interviews as any, registrationApplications as any, unitOfWork as any, auditService as any,
    );
    return { service, interviews, registrationApplications, unitOfWork, auditService, saved };
  };

  it('a pass creates the application and its invite, and links the two', async () => {
    const { service, registrationApplications } = setup();
    const interview = await service.record(
      { candidateName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com', outcome: InterviewOutcome.PASS },
      'user-1', 'System Admin', 'org-1',
    );

    // Two arguments now: the input, and the caller's transaction manager. The second is the
    // point — the application is written on the interview's own transaction, not beside it.
    expect(registrationApplications.createInviteRecord).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '9822014455', email: 'r@example.com', fullName: 'Ramesh Kulkarni' }),
      expect.anything(),
    );
    expect(interview.spawnedApplicationId).toBe('app-1');
  });

  it('a fail records the interview and sends nobody an invite', async () => {
    const { service, registrationApplications } = setup();
    const interview = await service.record(
      { candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.FAIL },
      'user-1', 'System Admin', 'org-1',
    );

    expect(registrationApplications.createInviteRecord).not.toHaveBeenCalled();
    expect(interview.spawnedApplicationId).toBeUndefined();
    expect(interview.outcome).toBe(InterviewOutcome.FAIL);
  });

  it('reports whether the invite actually reached the candidate, not merely that an address existed', async () => {
    /**
     * The screen announces "an invite has been emailed to …" off the back of this. With email
     * switched off in a deployment, the send answers `{success:false}` and nothing leaves — so a
     * flat `true` here would have HR believe a candidate was contacted who was not, and the
     * application then sits in DRAFT forever with nobody looking for it.
     */
    const { service, registrationApplications } = setup();
    registrationApplications.deliverInvite.mockResolvedValueOnce({ emailed: false, inviteLink: 'https://x/register/raw' });

    const interview = await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', email: 'r@example.com', outcome: InterviewOutcome.PASS },
      'user-1', 'HR', 'org-1',
    );
    expect(interview.inviteEmailed).toBe(false);
  });

  it('says an invite went out when it actually did', async () => {
    const { service } = setup();
    const interview = await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', email: 'r@example.com', outcome: InterviewOutcome.PASS },
      'user-1', 'HR', 'org-1',
    );
    expect(interview.inviteEmailed).toBe(true);
  });

  it('never claims an invite for a failed interview', async () => {
    const { service } = setup();
    const interview = await service.record(
      { candidateName: 'Suresh', mobile: '9811100033', outcome: InterviewOutcome.FAIL }, 'u', undefined,
    );
    expect(interview.inviteEmailed).toBe(false);
  });

  it('keeps who decided it and when, because this is the record of a decision', async () => {
    const { service } = setup();
    const interview = await service.record(
      { candidateName: 'A', mobile: '9', outcome: InterviewOutcome.PASS },
      'user-7', 'Priya from HR',
    );
    expect(interview.interviewedByUserId).toBe('user-7');
    expect(interview.interviewedByName).toBe('Priya from HR');
    expect(interview.interviewedAt).toBeInstanceOf(Date);
  });

  it('refuses a candidate with no name or no mobile', async () => {
    const { service } = setup();
    await expect(service.record(
      { candidateName: '  ', mobile: '9822014455', outcome: InterviewOutcome.PASS }, 'u', undefined,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.record(
      { candidateName: 'A', mobile: '', outcome: InterviewOutcome.PASS }, 'u', undefined,
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes the email through so the invite has somewhere to go, and tolerates its absence', async () => {
    // The spec's own field list for this form has no email; the invite is delivered by one, so HR
    // supplies it when known. A pass without one still records — it just cannot be emailed.
    const { service, registrationApplications } = setup();
    await service.record(
      { candidateName: 'No Email', mobile: '9811100044', outcome: InterviewOutcome.PASS }, 'u', undefined,
    );
    expect(registrationApplications.createInviteRecord).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
      expect.anything(),
    );
  });

  /**
   * Two PASS verdicts for one candidate.
   *
   * A second interview, or somebody pressing Record twice, used to mint a second application and a
   * second live token — no unique index, no idempotency key, nothing looking. Both sat in the
   * queue and whichever link the candidate happened to open became the real one.
   */
  it('does not start a second application for somebody who already has one open', async () => {
    const { service, registrationApplications } = setup();
    registrationApplications.openApplicationForMobile.mockResolvedValueOnce({ id: 'app-open' } as any);

    const interview = await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', outcome: InterviewOutcome.PASS }, 'u', 'HR', 'org-1',
    );

    expect(registrationApplications.createInviteRecord).not.toHaveBeenCalled();
    expect(interview.spawnedApplicationId).toBe('app-open');
    expect(interview.joinedExistingApplication).toBe(true);
  });

  it('still hands the desk a link in that case, so a repeat pass ends the way a first one does', async () => {
    const { service, registrationApplications } = setup();
    registrationApplications.openApplicationForMobile.mockResolvedValueOnce({ id: 'app-open' } as any);

    const interview = await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', outcome: InterviewOutcome.PASS }, 'u', 'HR', 'org-1',
    );

    expect(registrationApplications.resendInvite).toHaveBeenCalledWith('app-open', 'u');
    expect(interview.inviteLink).toBe('https://x/register/fresh');
  });

  it('does not go looking for one on a fail — nothing is being minted', async () => {
    const { service, registrationApplications } = setup();
    await service.record(
      { candidateName: 'Suresh', mobile: '9811100033', outcome: InterviewOutcome.FAIL }, 'u', 'HR', 'org-1',
    );
    expect(registrationApplications.openApplicationForMobile).not.toHaveBeenCalled();
  });

  /**
   * The email is the one thing that cannot be taken back, so it happens after the write commits.
   * It used to be sandwiched between two saves: a failure after it left a candidate holding a
   * working link to an application the desk's own log did not know about.
   */
  it('sends nothing until the write has committed', async () => {
    const { service, registrationApplications, unitOfWork } = setup();
    let sentDuringTransaction = false;
    unitOfWork.run.mockImplementationOnce(async (work: any) => {
      const result = await work({ save: jest.fn(async (_e: unknown, v: any) => Object.assign(v, { id: 'interview-1' })) });
      sentDuringTransaction = registrationApplications.deliverInvite.mock.calls.length > 0;
      return result;
    });

    await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', email: 'r@example.com', outcome: InterviewOutcome.PASS },
      'u', 'HR', 'org-1',
    );

    expect(sentDuringTransaction).toBe(false);
    expect(registrationApplications.deliverInvite).toHaveBeenCalled();
  });

  /**
   * This was the one decision in the pipeline that wrote no audit row at all, while approve,
   * reject, request-more-info and resend all wrote one. A FAIL is a hiring rejection and the
   * outcome a candidate is most likely to question — "we never interviewed them" and "we
   * interviewed them and said no" are different claims, and only one of them is checkable.
   */
  it('records a pass in the audit trail', async () => {
    const { service, auditService } = setup();
    await service.record(
      { candidateName: 'Ramesh', mobile: '9822014455', outcome: InterviewOutcome.PASS }, 'user-7', 'HR', 'org-1',
    );
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSAYER_INTERVIEW_PASSED', userId: 'user-7' }),
    );
  });

  it('records a fail in the audit trail too — it is a decision about a person', async () => {
    const { service, auditService } = setup();
    await service.record(
      { candidateName: 'Suresh', mobile: '9811100033', outcome: InterviewOutcome.FAIL }, 'user-7', 'HR', 'org-1',
    );
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSAYER_INTERVIEW_FAILED' }),
    );
  });
});

/**
 * Correcting a typo.
 *
 * The controller had POST and GET and nothing else, so a mistyped mobile number could only be
 * repaired by recording a second interview — which sent a second invite to the wrong number and
 * left the log claiming the candidate had been interviewed twice.
 */
describe('correcting what was typed', () => {
  const setup = () => {
    const interview: Record<string, any> = {
      id: 'interview-1', candidateName: 'Ramsh', mobile: '9822014455', email: null,
      spawnedApplicationId: 'app-1',
    };
    const interviews = { create: jest.fn(), findOne: jest.fn(async () => interview), find: jest.fn(async () => []) };
    const application: Record<string, any> = {
      id: 'app-1', status: ApplicationStatus.DRAFT, tokenConsumedAt: null,
      fullName: 'Ramsh', mobile: '9822014455', email: null,
    };
    const registrationApplications = {
      openApplicationForMobile: jest.fn(async () => null),
      createInviteRecord: jest.fn(),
      deliverInvite: jest.fn(),
      resendInvite: jest.fn(),
      findApplicationForAmend: jest.fn(async () => application),
    };
    const unitOfWork = { run: jest.fn(async (work: any) => work({ save: jest.fn(async (_e: unknown, v: any) => v) })) };
    const auditService = { recordEventSafe: jest.fn(async () => undefined) };
    const service = new AssayerInterviewService(
      interviews as any, registrationApplications as any, unitOfWork as any, auditService as any,
    );
    return { service, interview, application, auditService };
  };

  it('carries the correction onto the application, which is what the candidate will see', async () => {
    const { service, application } = setup();
    const saved = await service.amend('interview-1', { candidateName: 'Ramesh', mobile: '9822014466' }, 'u');

    expect(saved.candidateName).toBe('Ramesh');
    expect(application.fullName).toBe('Ramesh');
    expect(application.mobile).toBe('9822014466');
  });

  /**
   * The window closes the moment the candidate opens their link. After that the number is theirs
   * to correct — `verifyOtp` is what proves it — and overwriting a confirmed number from the desk
   * would undo that proof with nothing said.
   */
  it('refuses once the candidate has opened their link', async () => {
    const { service, application } = setup();
    application.tokenConsumedAt = new Date();
    await expect(service.amend('interview-1', { mobile: '9999999999' }, 'u'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses once they have submitted, for the same reason', async () => {
    const { service, application } = setup();
    application.status = ApplicationStatus.PENDING_VALIDATION;
    await expect(service.amend('interview-1', { mobile: '9999999999' }, 'u'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('records the correction, with both the before and the after', async () => {
    const { service, auditService } = setup();
    await service.amend('interview-1', { candidateName: 'Ramesh' }, 'user-9');
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ASSAYER_INTERVIEW_AMENDED',
        userId: 'user-9',
        remarks: expect.stringContaining('Ramsh'),
      }),
    );
  });
});

/**
 * The interview log is a list of people who do not work anywhere yet — names, mobile numbers and
 * email addresses — and it was served without an organisation predicate of any kind. An OPERATIONS
 * user in one organisation read every other organisation's candidates.
 *
 * `record()` has always stamped `organizationId` and the table has always been indexed on it.
 * Nothing read it back.
 */
describe('whose candidates the log returns', () => {
  const setup = () => {
    const interviews = { create: jest.fn(), findOne: jest.fn(), find: jest.fn(async () => []) };
    const service = new AssayerInterviewService(
      interviews as any,
      { openApplicationForMobile: jest.fn() } as any,
      { run: jest.fn() } as any,
      { recordEventSafe: jest.fn() } as any,
    );
    return { service, interviews };
  };

  const asPrincipal = (roleNames: string[], organizationId: string | undefined, fn: () => unknown) =>
    runWithRequestContext(
      { method: 'GET', route: '/assayer-interviews', roleNames, organizationId } as never,
      fn as never,
    );

  it('confines an OPERATIONS user to their own organisation', async () => {
    const { service, interviews } = setup();
    await asPrincipal(['OPERATIONS'], 'org-a', () => service.list());
    expect(interviews.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a' } }),
    );
  });

  it('lets ADMIN read across, which is what the platform operator is for', async () => {
    const { service, interviews } = setup();
    await asPrincipal([SystemRole.ADMIN], 'org-a', () => service.list());
    expect(interviews.find).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it('still answers newest first — the predicate is added, not substituted', async () => {
    const { service, interviews } = setup();
    await asPrincipal(['OPERATIONS'], 'org-a', () => service.list());
    expect(interviews.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { interviewedAt: 'DESC' } }),
    );
  });
});
