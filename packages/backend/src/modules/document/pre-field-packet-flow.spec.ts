import 'reflect-metadata';
import { AssignmentStatus, DocumentStatus, DocumentType } from '@fapoms/shared';
import { DocumentService } from './document.service';
import { DocumentController } from './document.controller';
import { DocumentDispatchWorker } from './document-dispatch.worker';
import { AUDIT_READ_KEY } from '../../core/audit/audit-read.decorator';
import { pendingOfferReadiness } from '../assignment/packet-readiness';
import { NotificationService } from '../notifications/notification.service';

/**
 * The pre-field audit packet, from dispatch to the assayer's phone — the defects closed on
 * 2026-09-24 without changing who uploads, how dispatch works, or what the assayer sees:
 *
 *  1. the nightly scan skipped a packet whose assayer had already checked in or started;
 *  2. an offer nobody had accepted could open the packet, and was told it had been sent;
 *  3. an assayer who took the job after dispatch (accepted late, or reassigned) was never told;
 *  5. fetching the file itself left no access record;
 *  7. dispatch could pick a dead (cancelled) row for the branch and tell nobody alive.
 */

function makeService(over: Partial<Record<string, any>> = {}): any {
  const svc: any = Object.create(DocumentService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.notificationService = { notifyAssayer: jest.fn(async () => ({ inAppDelivered: true })) };
  svc.documentRepository = { save: jest.fn(async (v: any) => v) };
  svc.assignmentRepository = { find: jest.fn(async () => []) };
  Object.assign(svc, over);
  return svc;
}

describe('dispatch tells only an assayer who has accepted (item 2)', () => {
  const uploaded = { id: 'doc-1', status: DocumentStatus.UPLOADED, fileName: 'packet.pdf', assessmentId: 'asm-1' };

  const dispatchWith = async (rows: any[]) => {
    const svc = makeService();
    svc.findOne = jest.fn(async () => ({ ...uploaded }));
    svc.updateStatus = jest.fn(async () => ({ ...uploaded, status: DocumentStatus.DISPATCHED }));
    svc.assignmentRepository.find = jest.fn(async () => rows);
    await svc.dispatchDocument('doc-1', 'ops-1');
    return svc;
  };
  const asn = (id: string, status: AssignmentStatus, assayerId = `as-${id}`) => ({
    id, status, assayerId, assayer: { id: assayerId, email: null },
  });

  it.each([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS])(
    'tells a %s assayer, once-only keyed per packet and assayer',
    async (status) => {
      const svc = await dispatchWith([asn('a1', status)]);
      expect(svc.notificationService.notifyAssayer).toHaveBeenCalledTimes(1);
      const [assayerId, , payload] = svc.notificationService.notifyAssayer.mock.calls[0];
      expect(assayerId).toBe('as-a1');
      expect(payload.dedupeKey).toBe(DocumentService.packetNoticeKey('doc-1', 'as-a1'));
      expect(payload.link).toBe('/assignments?id=a1');
    },
  );

  it('does not tell an assayer whose offer is still unanswered (PENDING)', async () => {
    const svc = await dispatchWith([asn('a1', AssignmentStatus.PENDING)]);
    expect(svc.notificationService.notifyAssayer).not.toHaveBeenCalled();
  });

  it('does not tell a cancelled job', async () => {
    const svc = await dispatchWith([asn('a1', AssignmentStatus.CANCELLED)]);
    expect(svc.notificationService.notifyAssayer).not.toHaveBeenCalled();
  });

  it('picks the live job for the branch, not a cancelled row returned first (item 7)', async () => {
    const svc = await dispatchWith([
      asn('dead', AssignmentStatus.CANCELLED, 'as-old'),
      asn('live', AssignmentStatus.ACCEPTED, 'as-new'),
    ]);
    expect(svc.notificationService.notifyAssayer).toHaveBeenCalledTimes(1);
    expect(svc.notificationService.notifyAssayer.mock.calls[0][0]).toBe('as-new');
  });
});

describe('an assayer who accepts after the packet went out is told (items 2 and 3)', () => {
  const doc = (id: string, type: DocumentType, status: DocumentStatus, dispatchedToEmail: string | null = null) => ({
    id, type, status, fileName: `${id}.pdf`, dispatchedToEmail,
  });

  it('tells them about each DISPATCHED pre-field packet, under the same key dispatch uses', async () => {
    const svc = makeService();
    svc.findByProjectBranch = jest.fn(async () => [
      doc('pkt', DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.DISPATCHED),
      doc('unsent', DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.UPLOADED),
      doc('ret', DocumentType.AUDITED_RETURN_PDF, DocumentStatus.DISPATCHED),
    ]);

    const told = await svc.notifyAcceptedAssayerOfDispatchedPacket(
      { id: 'asn-1', assayerId: 'as-new', projectBranchId: 'pb-1' }, 'ops-1',
    );

    expect(told).toBe(1);
    expect(svc.findByProjectBranch).toHaveBeenCalledWith('pb-1');
    const calls = svc.notificationService.notifyAssayer.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('as-new');
    expect(calls[0][2]).toMatchObject({
      title: 'New Audit PDF',
      link: '/assignments?id=asn-1',
      dedupeKey: DocumentService.packetNoticeKey('pkt', 'as-new'),
      data: { documentId: 'pkt', assignmentId: 'asn-1', type: 'document_dispatched' },
    });
  });

  it('says "collect it at the branch" when the packet was emailed to the branch', async () => {
    const svc = makeService();
    svc.findByProjectBranch = jest.fn(async () => [
      doc('pkt', DocumentType.PRE_FIELD_AUDIT_PDF, DocumentStatus.DISPATCHED, 'mgr@bank.example'),
    ]);
    await svc.notifyAcceptedAssayerOfDispatchedPacket({ id: 'asn-1', assayerId: 'as-1', projectBranchId: 'pb-1' }, 'u');
    expect(svc.notificationService.notifyAssayer.mock.calls[0][2].message).toMatch(/mgr@bank\.example.*Collect it/);
  });

  it('never throws — an acceptance must not fail because a notice did not go', async () => {
    const svc = makeService();
    svc.findByProjectBranch = jest.fn(async () => { throw new Error('db down'); });
    await expect(
      svc.notifyAcceptedAssayerOfDispatchedPacket({ id: 'asn-1', assayerId: 'as-1', projectBranchId: 'pb-1' }, 'u'),
    ).resolves.toBe(0);
  });
});

describe('notifyAssayer honours a once-only key', () => {
  const make = (existing: number): any => {
    const svc: any = Object.create(NotificationService.prototype);
    svc.notificationRepository = {
      count: jest.fn(async () => existing),
      create: jest.fn((v: any) => v),
      save: jest.fn(async (v: any) => v),
    };
    svc.preferenceRepository = { findOne: jest.fn(async () => null) };
    svc.pushNotificationService = { sendToUser: jest.fn(async () => undefined) };
    return svc;
  };

  it('writes the key on the row and pushes the first time', async () => {
    const svc = make(0);
    const res = await svc.notifyAssayer('as-1', null, { title: 't', message: 'm', dedupeKey: 'K:1' });
    expect(res.inAppDelivered).toBe(true);
    expect(svc.notificationRepository.save).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'K:1', assayerId: 'as-1' }));
    expect(svc.pushNotificationService.sendToUser).toHaveBeenCalled();
  });

  it('writes nothing and pushes nothing when that key already reached them', async () => {
    const svc = make(1);
    const res = await svc.notifyAssayer('as-1', null, { title: 't', message: 'm', dedupeKey: 'K:1' });
    expect(res).toEqual({ inAppDelivered: false, duplicate: true });
    expect(svc.notificationRepository.save).not.toHaveBeenCalled();
    expect(svc.pushNotificationService.sendToUser).not.toHaveBeenCalled();
  });

  it('is unchanged without a key', async () => {
    const svc = make(5);
    await svc.notifyAssayer('as-1', null, { title: 't', message: 'm' });
    expect(svc.notificationRepository.count).not.toHaveBeenCalled();
    expect(svc.notificationRepository.save).toHaveBeenCalledWith(expect.not.objectContaining({ dedupeKey: expect.anything() }));
  });
});

describe('the job list does not call an unanswered offer\'s packet "ready" (item 2)', () => {
  const ready = { state: 'READY' as const, dispatchedCount: 1, message: '1 document ready to download.' };

  it('an offer (PENDING) is told the paperwork opens once they accept', () => {
    const r = pendingOfferReadiness(AssignmentStatus.PENDING, ready);
    expect(r.state).toBe('PREPARING');
    expect(r.dispatchedCount).toBe(0);
    expect(r.message).toMatch(/accept/i);
  });

  it.each([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED])(
    'a %s job is shown exactly what the branch has',
    (status) => {
      expect(pendingOfferReadiness(status, ready)).toBe(ready);
    },
  );

  it('does not invent readiness for an offer when nothing was sent', () => {
    const none = { state: 'NONE' as const, dispatchedCount: 0, message: 'x' };
    expect(pendingOfferReadiness(AssignmentStatus.PENDING, none)).toBe(none);
  });
});

describe('the nightly auto-dispatch covers an assayer already on site (item 1)', () => {
  it('asks for ACCEPTED, CHECKED_IN and IN_PROGRESS jobs — never PENDING or finished ones', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const w: any = Object.create(DocumentDispatchWorker.prototype);
    w.logger = { log: jest.fn(), error: jest.fn() };
    w.documentRepository = {
      find: jest.fn(async () => [{
        id: 'doc-1', type: DocumentType.PRE_FIELD_AUDIT_PDF, status: DocumentStatus.UPLOADED,
        assessment: { id: 'asm-1', projectId: 'p', branchId: 'b' },
      }]),
      manager: { query: jest.fn(async () => [{ project_id: 'p', branch_id: 'b', scheduled_date: tomorrow.toISOString().slice(0, 10) }]) },
    };
    w.assignmentRepository = { find: jest.fn(async () => [{ id: 'asn-1', assessmentId: 'asm-1' }]) };
    w.documentService = { dispatchDocument: jest.fn(async () => ({})) };
    w.autoSendToOcr = jest.fn(async () => 0);

    const result = await w.autoDispatch({});

    const where = w.assignmentRepository.find.mock.calls[0][0].where;
    const statuses: string[] = [...where.status.value].sort();
    expect(statuses).toEqual([AssignmentStatus.ACCEPTED, AssignmentStatus.CHECKED_IN, AssignmentStatus.IN_PROGRESS].sort());
    expect(result.dispatchedCount).toBe(1);
  });
});

describe('fetching a document leaves an access record (item 5)', () => {
  it('the signed-token download route is recorded', () => {
    const options = Reflect.getMetadata(AUDIT_READ_KEY, DocumentController.prototype.downloadFile);
    expect(options).toMatchObject({ resource: 'DOCUMENT', idParam: 'id', eventType: 'DOCUMENT_DOWNLOADED' });
  });

  it('the branch-addressed packet download (which calls downloadFile directly) is recorded too', () => {
    const options = Reflect.getMetadata(AUDIT_READ_KEY, DocumentController.prototype.downloadBranchPdf);
    expect(options).toMatchObject({ idParam: 'projectBranchId', eventType: 'PRE_FIELD_PACKET_DOWNLOADED' });
  });
});
