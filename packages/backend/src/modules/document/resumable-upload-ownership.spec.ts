import { createHash } from 'crypto';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, OTHER_CONFLICT_ERROR_CODES, SystemRole } from '@fapoms/shared';
import { DocumentController } from './document.controller';
import { ChunkedUploadService } from './chunked-upload.service';

/**
 * The resumable upload's three holes, pinned through the real route handlers and the real
 * `ChunkedUploadService` (only Redis and the object store are faked).
 *
 *  1. Session routes acted on any `uploadId`: another account could read progress, push chunks
 *     into, or complete somebody else's session. Now only the opener may, and a foreign session
 *     answers exactly like a missing one.
 *  2. Opening a session ran no "may submit a return for this assignment" check at all.
 *  3. Neither the chunked path nor the single-shot binary path refused a job that had already
 *     finished (the shared terminal rule). Both now do, through ONE function — except for a
 *     byte-identical retry of the return already stored, which is answered with that document.
 *
 * Staff keep their back-office path: they may upload for an assayer and on a finished job.
 */
describe('Resumable upload: session ownership and the finished-job rule', () => {
  const OWNER = 'assayer-owner';
  const OTHER = 'assayer-other';
  const ASN = '11111111-1111-4111-8111-111111111111';

  let redisStore: Map<string, string>;
  let parts: Set<number>;
  let assignment: { id: string; assignmentNumber: string; assayerId: string; status: AssignmentStatus; projectBranchId: string; projectBranch: any };

  const redis: any = {
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { redisStore.delete(k); return 1; }),
    keys: jest.fn(async () => [...redisStore.keys()]),
  };
  const storage: any = {
    createMultipartUpload: jest.fn(async (fileName: string) => ({ uploadId: `s3-${fileName}`, key: `uploads/${fileName}` })),
    uploadPart: jest.fn(async (_k: string, _u: string, n: number) => { parts.add(n); }),
    listUploadedParts: jest.fn(async () => [...parts].sort((a, b) => a - b)),
    getSignedPartUploadUrl: jest.fn(async () => 'https://example/part'),
    completeMultipartUpload: jest.fn(async () => undefined),
    abortMultipartUpload: jest.fn(async () => undefined),
    getFileStream: jest.fn(async () => [ASSEMBLED]),
    deleteFile: jest.fn(async () => undefined),
    saveFile: jest.fn(async () => 'uploads/single.pdf'),
  };
  const ASSEMBLED = Buffer.from('%PDF-1.4 test');
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  /** The return the first (delivered) attempt stored, keyed by its content hash. */
  let storedReturns: Array<{ id: string; assessmentId: string; contentSha256: string }>;
  const documentService: any = {
    findStoredReturnByContent: jest.fn(async (targets: string[], hash: string) =>
      storedReturns.find((d) => targets.includes(d.assessmentId) && d.contentSha256 === hash) ?? null),
    create: jest.fn(async (dto: any) => ({ id: 'doc-1', assessmentId: dto.assessmentId })),
    receiveDocument: jest.fn(async (id: string) => ({ id, assessmentId: ASN })),
  };
  const assignmentRepo: any = {
    findOne: jest.fn(async ({ where }: any) => (where?.id === assignment.id || where?.assessmentId || where?.projectBranchId ? assignment : null)),
    find: jest.fn(async ({ where }: any) =>
      (where as any[]).some((w) => (w.id === assignment.id || w.projectBranchId === assignment.projectBranchId) && w.assayerId === assignment.assayerId)
        ? [assignment]
        : []),
  };
  const assignmentService: any = { completeAssignment: jest.fn(async () => undefined) };
  const scanner: any = { scanOrThrow: jest.fn(async () => undefined) };

  let chunked: ChunkedUploadService;
  let ctrl: DocumentController;

  const assayer = (id: string) => ({ user: { id, assayerId: id, roles: [{ name: SystemRole.ASSAYER }] } });
  const staff = () => ({ user: { id: 'staff-1', roles: [{ name: SystemRole.OPERATIONS }] } });

  beforeEach(() => {
    jest.clearAllMocks();
    redisStore = new Map();
    parts = new Set();
    storedReturns = [];
    assignment = {
      id: ASN,
      assignmentNumber: 'ASN-0001',
      assayerId: OWNER,
      status: AssignmentStatus.IN_PROGRESS,
      projectBranchId: 'pb-1',
      projectBranch: {},
    };
    chunked = new ChunkedUploadService(storage, redis);
    ctrl = new DocumentController(
      documentService,
      storage,
      null as any, // ocr
      assignmentRepo,
      null as any, // assessmentRepository
      null as any, // validationService
      assignmentService,
      { issue: jest.fn() } as any,
      chunked,
      scanner,
      { assertRegionAllowed: jest.fn(), assertRegionAllowedStaged: jest.fn() } as any,
      null as any, // dispatchJobs,
      null as any, // backgroundJobs
    );
  });

  // The installed app opens the session with the ASSIGNMENT's id in `assessmentId`.
  const open = (req: any) =>
    ctrl.createUploadSession({ assessmentId: ASN, fileName: 'return.pdf', fileSize: 10 } as any, req);

  describe('only the account that opened a session may use it', () => {
    it('refuses another assayer\'s chunk as if the session did not exist, and stores nothing', async () => {
      const session = await open(assayer(OWNER));
      await expect(
        ctrl.uploadChunk(session.uploadId, '0', { buffer: Buffer.from('x') }, assayer(OTHER)),
      ).rejects.toThrow(NotFoundException);
      expect(storage.uploadPart).not.toHaveBeenCalled();
    });

    it('refuses another assayer\'s completion before anything is assembled or registered', async () => {
      const session = await open(assayer(OWNER));
      await ctrl.uploadChunk(session.uploadId, '0', { buffer: Buffer.from('x') }, assayer(OWNER));
      await expect(
        ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, assayer(OTHER)),
      ).rejects.toThrow(NotFoundException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(documentService.create).not.toHaveBeenCalled();
      // The owner's session is untouched and can still be finished.
      expect(redisStore.size).toBe(1);
    });

    it('refuses a staff account too — staff open their own session to upload on someone\'s behalf', async () => {
      const session = await open(assayer(OWNER));
      await expect(ctrl.completeUpload(session.uploadId, {} as any, staff())).rejects.toThrow(NotFoundException);
      await expect(ctrl.getUploadSession(session.uploadId, staff())).rejects.toThrow(NotFoundException);
    });

    it('refuses another assayer\'s status read and presigned part URL', async () => {
      const session = await open(assayer(OWNER));
      await expect(ctrl.getUploadSession(session.uploadId, assayer(OTHER))).rejects.toThrow(NotFoundException);
      await expect(ctrl.getChunkPresignedUrl(session.uploadId, '0', assayer(OTHER))).rejects.toThrow(NotFoundException);
      expect(storage.getSignedPartUploadUrl).not.toHaveBeenCalled();
    });

    it('lets the opener send, resume and complete their own upload', async () => {
      const session = await open(assayer(OWNER));
      await ctrl.uploadChunk(session.uploadId, '0', { buffer: Buffer.from('x') }, assayer(OWNER));
      const status = await ctrl.getUploadSession(session.uploadId, assayer(OWNER));
      expect(status.missingChunks).toEqual([]);
      const res = await ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, assayer(OWNER));
      expect(res.success).toBe(true);
      expect(documentService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('opening a session applies the "may submit a return" rule', () => {
    it('refuses an assayer who holds no assignment on the target, before the store is touched', async () => {
      await expect(open(assayer(OTHER))).rejects.toThrow(ForbiddenException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('lets the OWNER open a session on a finished job — no bytes exist yet; completion decides', async () => {
      // The installed app retries through a fresh session every time, so refusing here would
      // refuse the identical-file retry before its bytes could be recognised.
      assignment.status = AssignmentStatus.COMPLETED;
      await expect(open(assayer(OWNER))).resolves.toMatchObject({ createdBy: OWNER });
    });

    it('still lets staff open a session on a finished job (back-office scan-by-email)', async () => {
      assignment.status = AssignmentStatus.COMPLETED;
      await expect(open(staff())).resolves.toMatchObject({ createdBy: 'staff-1' });
    });
  });

  describe('session completion on a finished job', () => {
    const sendAll = async () => {
      const session = await open(assayer(OWNER));
      await ctrl.uploadChunk(session.uploadId, '0', { buffer: Buffer.from('x') }, assayer(OWNER));
      return session;
    };

    it('answers an identical retry (fresh session, same bytes) with the EXISTING document, writing nothing', async () => {
      // First attempt delivered: stored under the assignment's own id, job closed; response lost.
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(ASSEMBLED) }];
      assignment.status = AssignmentStatus.COMPLETED;
      const session = await sendAll();

      const res = await ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, assayer(OWNER));

      expect(res).toEqual({ success: true, assignmentCompletion: { completed: true }, data: storedReturns[0] });
      expect(documentService.create).not.toHaveBeenCalled();
      expect(documentService.receiveDocument).not.toHaveBeenCalled();
      expect(assignmentService.completeAssignment).not.toHaveBeenCalled();
      // The duplicate object assembled for the retry is removed, and the session closed.
      expect(storage.deleteFile).toHaveBeenCalledWith('uploads/return.pdf');
      expect(redisStore.size).toBe(0);
    });

    it('refuses a DIFFERENT file on the finished job with ASSIGNMENT_CLOSED, and deletes the assembled object', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: 'f'.repeat(64) }];
      const session = await sendAll();
      assignment.status = AssignmentStatus.COMPLETED; // closed after the session was opened

      const err = await ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, assayer(OWNER)).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.code ?? err.getResponse?.().code).toBe(OTHER_CONFLICT_ERROR_CODES.ASSIGNMENT_CLOSED);
      expect(documentService.create).not.toHaveBeenCalled();
      expect(storage.deleteFile).toHaveBeenCalledWith('uploads/return.pdf');
    });

    it.each([AssignmentStatus.CANCELLED, AssignmentStatus.REJECTED])('refuses a new file on a %s job the same way', async (status) => {
      const session = await sendAll();
      assignment.status = status;
      await expect(ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, assayer(OWNER))).rejects.toThrow(ConflictException);
    });

    it('does not replay a matching file for staff — staff uploads are unaffected and register as before', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(ASSEMBLED) }];
      assignment.status = AssignmentStatus.COMPLETED;
      const session = await open(staff());
      await ctrl.uploadChunk(session.uploadId, '0', { buffer: Buffer.from('x') }, staff());
      const res = await ctrl.completeUpload(session.uploadId, { assignmentId: ASN } as any, staff());
      expect(res.success).toBe(true);
      expect(documentService.findStoredReturnByContent).not.toHaveBeenCalled();
      expect(documentService.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('the single-shot routes use the same rule', () => {
    const PDF = Buffer.from('%PDF-1.4 single');
    const file = (buffer = PDF) => ({ buffer, size: buffer.length, mimetype: 'application/pdf', originalname: 'r.pdf' });

    it('binary: answers an identical retry on a completed job with the existing document, storing nothing', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(PDF) }];
      assignment.status = AssignmentStatus.COMPLETED;
      const res = await ctrl.mobileUploadBinary(file(), ASN, ASN, assayer(OWNER));
      expect(res).toEqual({ success: true, assignmentCompletion: { completed: true }, data: storedReturns[0] });
      expect(storage.saveFile).not.toHaveBeenCalled();
      expect(documentService.create).not.toHaveBeenCalled();
      expect(assignmentService.completeAssignment).not.toHaveBeenCalled();
    });

    it('binary: refuses a different file on a completed job before it is stored', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(PDF) }];
      assignment.status = AssignmentStatus.COMPLETED;
      await expect(ctrl.mobileUploadBinary(file(Buffer.from('%PDF-1.4 other')), ASN, ASN, assayer(OWNER)))
        .rejects.toThrow(ConflictException);
      expect(storage.saveFile).not.toHaveBeenCalled();
    });

    it('binary: does not look at stored files at all while the job is open', async () => {
      await ctrl.mobileUploadBinary(file(), ASN, ASN, assayer(OWNER));
      expect(documentService.findStoredReturnByContent).not.toHaveBeenCalled();
      expect(documentService.create).toHaveBeenCalledTimes(1);
    });

    it('binary: staff on a completed job upload exactly as before', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(PDF) }];
      assignment.status = AssignmentStatus.COMPLETED;
      await ctrl.mobileUploadBinary(file(), ASN, ASN, staff());
      expect(storage.saveFile).toHaveBeenCalled();
      expect(documentService.create).toHaveBeenCalledTimes(1);
    });

    it('JSON: answers an identical retry with the existing document and its download link', async () => {
      storedReturns = [{ id: 'doc-first', assessmentId: ASN, contentSha256: sha(PDF) }];
      assignment.status = AssignmentStatus.COMPLETED;
      const res = await ctrl.mobileUpload({ assignmentId: ASN, fileData: PDF.toString('base64') }, assayer(OWNER));
      expect(res).toEqual({
        success: true,
        assignmentCompletion: { completed: true },
        data: storedReturns[0],
        documentUrl: '/documents/doc-first/download',
      });
      expect(scanner.scanOrThrow).not.toHaveBeenCalled();
      expect(storage.saveFile).not.toHaveBeenCalled();
    });

    it('JSON: refuses a different file on a completed job', async () => {
      assignment.status = AssignmentStatus.COMPLETED;
      await expect(ctrl.mobileUpload({ assignmentId: ASN, fileData: PDF.toString('base64') }, assayer(OWNER)))
        .rejects.toThrow(ConflictException);
      expect(storage.saveFile).not.toHaveBeenCalled();
    });
  });
});
