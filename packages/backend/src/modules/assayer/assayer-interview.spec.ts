import { BadRequestException } from '@nestjs/common';
import { InterviewOutcome } from '@fapoms/shared';

import { AssayerInterviewService } from './assayer-interview.service';

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
    const interviews = {
      create: jest.fn((v: Record<string, any>) => ({ ...v })),
      save: jest.fn(async (v: Record<string, any>) => {
        const row = { ...v, id: v.id ?? 'interview-1' };
        saved.push(row);
        // The service mutates and re-saves the same object to record the spawned application.
        Object.assign(v, { id: row.id });
        return v;
      }),
      find: jest.fn(async () => []),
    };
    const registrationApplications = {
      createInvite: jest.fn(async (_input: Record<string, any>) => ({ id: 'app-1' })),
    };
    const service = new AssayerInterviewService(interviews as any, registrationApplications as any);
    return { service, interviews, registrationApplications, saved };
  };

  it('a pass creates the application and its invite, and links the two', async () => {
    const { service, registrationApplications } = setup();
    const interview = await service.record(
      { candidateName: 'Ramesh Kulkarni', mobile: '9822014455', email: 'r@example.com', outcome: InterviewOutcome.PASS },
      'user-1', 'System Admin', 'org-1',
    );

    expect(registrationApplications.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ mobile: '9822014455', email: 'r@example.com', fullName: 'Ramesh Kulkarni' }),
    );
    expect(interview.spawnedApplicationId).toBe('app-1');
  });

  it('a fail records the interview and sends nobody an invite', async () => {
    const { service, registrationApplications } = setup();
    const interview = await service.record(
      { candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.FAIL },
      'user-1', 'System Admin', 'org-1',
    );

    expect(registrationApplications.createInvite).not.toHaveBeenCalled();
    expect(interview.spawnedApplicationId).toBeUndefined();
    expect(interview.outcome).toBe(InterviewOutcome.FAIL);
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
    expect(registrationApplications.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
    );
  });
});
