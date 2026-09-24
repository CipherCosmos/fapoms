import { ConflictException } from '@nestjs/common';
import { InterviewOutcome } from '@fapoms/shared';
import { AssayerInterviewService, MAX_INTERVIEW_FILES } from './assayer-interview.service';

/**
 * THE INTERVIEW'S TEST PAPERS, AND INTERVIEWING AGAIN (owner, 2026-09-23).
 *
 * "Passed" and "did not pass" are recorded with the test they rested on. Somebody who did not pass
 * can be interviewed again: the new interview names the old one, and the old one — its outcome and
 * its papers — stays as it was. Every step is on the audit trail.
 */
describe('interview files and retakes', () => {
  const failed = {
    id: 'int-1', candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.FAIL,
    interviewedAt: new Date('2026-09-01T10:00:00Z'), attachments: [] as any[], previousInterviewId: null,
  };

  const setup = (rows: Record<string, any>[] = [{ ...failed, attachments: [] }]) => {
    const interviews = {
      create: jest.fn((v: Record<string, any>) => ({ ...v })),
      findOne: jest.fn(async ({ where }: any) => rows.find((r) =>
        (where.id === undefined || r.id === where.id)
        && (where.previousInterviewId === undefined || r.previousInterviewId === where.previousInterviewId)) ?? null),
      save: jest.fn(async (v: any) => v),
      find: jest.fn(async () => rows),
    };
    const save = jest.fn(async (_e: unknown, v: Record<string, any>) => { v.id = v.id ?? 'int-2'; rows.push(v); return v; });
    const registrationApplications = {
      openApplicationForMobile: jest.fn(async () => null),
      createInviteRecord: jest.fn(async () => ({ application: { id: 'app-1' }, rawToken: 'raw' })),
      deliverInvite: jest.fn(async () => ({ emailDelivery: null, inviteLink: 'https://x/register/raw' })),
      resendInvite: jest.fn(),
    };
    const unitOfWork = { run: jest.fn(async (work: any) => work({ save })) };
    const auditService = { recordEventSafe: jest.fn(async () => undefined) };
    const service = new AssayerInterviewService(interviews as any, registrationApplications as any, unitOfWork as any, auditService as any);
    return { service, interviews, auditService, rows, registrationApplications };
  };

  const paper = { storageKey: 'uploads/test-paper.pdf', fileName: 'test-paper.pdf', mimeType: 'application/pdf', size: 1200, sha256: 'abc' };

  describe('the test papers', () => {
    it('keeps a file with a failed interview, and says so on the trail', async () => {
      const { service, auditService, rows } = setup();
      await service.attachFile('int-1', paper, 'hr-1', 'Asha Menon');

      expect(rows[0].attachments).toEqual([
        expect.objectContaining({ storageKey: 'uploads/test-paper.pdf', fileName: 'test-paper.pdf', sha256: 'abc', uploadedBy: 'hr-1', uploadedByName: 'Asha Menon' }),
      ]);
      expect(auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_INTERVIEW_FILE_ATTACHED', entityId: 'int-1',
      }));
    });

    it('adds to what is there, never replacing it', async () => {
      const { service, rows } = setup();
      await service.attachFile('int-1', paper, 'hr-1');
      await service.attachFile('int-1', { ...paper, storageKey: 'uploads/answers.pdf', fileName: 'answers.pdf' }, 'hr-1');
      expect(rows[0].attachments.map((a: any) => a.fileName)).toEqual(['test-paper.pdf', 'answers.pdf']);
    });

    it('caps how many one interview keeps', async () => {
      const { service, rows } = setup();
      rows[0].attachments = Array.from({ length: MAX_INTERVIEW_FILES }, (_, i) => ({ ...paper, storageKey: `k${i}` }));
      await expect(service.attachFile('int-1', paper, 'hr-1')).rejects.toThrow(/at most/);
    });

    it('serves a file by its place, and nothing past the end', async () => {
      const { service } = setup();
      await service.attachFile('int-1', paper, 'hr-1');
      await expect(service.fileKey('int-1', 0)).resolves.toEqual({ key: 'uploads/test-paper.pdf', fileName: 'test-paper.pdf' });
      await expect(service.fileKey('int-1', 1)).resolves.toBeNull();
    });
  });

  describe('interviewing again', () => {
    it('links the new interview to the one that did not pass, and invites them on a pass', async () => {
      const { service, auditService, registrationApplications, rows } = setup();
      const retake = await service.record(
        { candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.PASS, previousInterviewId: 'int-1' },
        'hr-1', 'Asha Menon', 'org-1',
      );

      expect(retake.previousInterviewId).toBe('int-1');
      expect(registrationApplications.createInviteRecord).toHaveBeenCalled();
      // The failed one is untouched.
      expect(rows[0].outcome).toBe(InterviewOutcome.FAIL);
      // Both records say it.
      const events = auditService.recordEventSafe.mock.calls.map((c: any[]) => c[0]);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'ASSAYER_INTERVIEW_PASSED', metadata: expect.objectContaining({ previousInterviewId: 'int-1' }) }),
        expect.objectContaining({ eventType: 'ASSAYER_INTERVIEW_RETAKEN', entityId: 'int-1' }),
      ]));
    });

    it('does not follow an interview that passed', async () => {
      const { service } = setup([{ ...failed, outcome: InterviewOutcome.PASS }]);
      await expect(service.record(
        { candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.PASS, previousInterviewId: 'int-1' },
        'hr-1', undefined, 'org-1',
      )).rejects.toThrow(/Only an interview that did not pass/);
    });

    it('does not follow the same interview twice', async () => {
      const { service } = setup([{ ...failed }, { id: 'int-2', previousInterviewId: 'int-1', outcome: InterviewOutcome.FAIL }]);
      await expect(service.record(
        { candidateName: 'Suresh Patil', mobile: '9811100033', outcome: InterviewOutcome.PASS, previousInterviewId: 'int-1' },
        'hr-1', undefined, 'org-1',
      )).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses an earlier interview that is not there', async () => {
      const { service } = setup([]);
      await expect(service.record(
        { candidateName: 'X', mobile: '9811100033', outcome: InterviewOutcome.FAIL, previousInterviewId: 'nope' },
        'hr-1', undefined, 'org-1',
      )).rejects.toThrow(/earlier interview was not found/);
    });
  });

  describe('who referred them', () => {
    const ravi = { type: 'STAFF', name: 'Ravi Kumar', mobile: '98765 43210', email: '' };

    it('is kept on the interview, and handed to the application a pass opens', async () => {
      const { service, registrationApplications, rows } = setup([]);
      await service.record(
        { candidateName: 'Ramesh Kumar', mobile: '9876543210', outcome: InterviewOutcome.PASS, sourceReferral: ravi },
        'hr-1', 'Asha Menon', 'org-1',
      );
      const stored = { type: 'STAFF', name: 'Ravi Kumar', mobile: '9876543210', email: null, recordedBy: 'HR' };
      expect(rows[0].sourceReferral).toEqual(stored);
      expect(registrationApplications.createInviteRecord).toHaveBeenCalledWith(
        expect.objectContaining({ sourceReferral: stored }), expect.anything(),
      );
    });

    it('refuses one nobody could reach, before anything is written', async () => {
      const { service, rows } = setup([]);
      await expect(service.record(
        { candidateName: 'Ramesh Kumar', mobile: '9876543210', outcome: InterviewOutcome.FAIL, sourceReferral: { ...ravi, mobile: '' } },
        'hr-1', undefined, 'org-1',
      )).rejects.toThrow(/mobile or an email/);
      expect(rows).toHaveLength(0);
    });
  });
});
