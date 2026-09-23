import { DocumentVerification, OnboardingDocument } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';

/**
 * The same storage key twice is the same file, not a second page.
 *
 * Promotion re-homes an application's scans onto the new record by key, in the step between "the
 * person exists" and "the application is closed" — the step most likely to be repeated, because a
 * failure after it leaves the reviewer pressing Approve again. Appending blindly turned one retry
 * into two copies of every scan, and a document's file list is evidence in a bank audit.
 *
 * The rule itself lives in `RosterRecordsService.attachFile`; this pins the shape of it, which is
 * what the promotion loop depends on.
 */
describe('attaching a file the record already has', () => {
  const attach = (existing: string[], key: string, requirement: OnboardingDocument): string[] => {
    const alreadyAttached = existing ?? [];
    return requirement === OnboardingDocument.PHOTOGRAPH
      ? [key]
      : alreadyAttached.includes(key) ? alreadyAttached : [...alreadyAttached, key];
  };

  it('changes nothing when the key is already there', () => {
    expect(attach(['uploads/pan.png'], 'uploads/pan.png', OnboardingDocument.PAN_CARD))
      .toEqual(['uploads/pan.png']);
  });

  it('still appends a genuinely new page', () => {
    expect(attach(['uploads/a1.png'], 'uploads/a2.png', OnboardingDocument.AADHAAR_FRONT))
      .toEqual(['uploads/a1.png', 'uploads/a2.png']);
  });

  it('still replaces a photograph, because a face is not evidence that accumulates', () => {
    expect(attach(['uploads/old.jpg'], 'uploads/new.jpg', OnboardingDocument.PHOTOGRAPH))
      .toEqual(['uploads/new.jpg']);
  });
});

/**
 * The same rule, on the real service — the part the shape above cannot see.
 *
 * Keeping the key out of the file list twice was never the whole of it: every attach also filed a
 * new document VERSION, marked the previous one superseded, withdrew any verification and wrote
 * the audit line again. A promotion retried after a failure part way therefore left every scan
 * with a phantom second version of itself. And the file list could not have caught it for a
 * photograph, which keeps only its latest key — so an application carrying two photographs looked
 * un-attached on the retry.
 */
describe('RosterRecordsService.attachFile, repeated with keys it already holds', () => {
  type Row = Record<string, any>;

  const harness = () => {
    const documents: Row[] = [];
    const versions: Row[] = [];
    let nextId = 1;

    const onboarding = {
      findOne: jest.fn(async ({ where }: { where: Row }) =>
        documents.find((d) => d.assayerId === where.assayerId && d.requirement === where.requirement) ?? null),
      create: jest.fn((v: Row) => ({ ...v })),
      save: jest.fn(async (row: Row) => {
        if (!row.id) {
          row.id = `doc-${nextId++}`;
          documents.push(row);
        }
        return row;
      }),
    };
    const docVersions = {
      findOne: jest.fn(async ({ where }: { where: Row }) => {
        const mine = versions.filter((v) => v.documentId === where.documentId
          && (where.filePath === undefined || v.filePath === where.filePath));
        return mine.sort((a, b) => b.version - a.version)[0] ?? null;
      }),
      create: jest.fn((v: Row) => ({ ...v })),
      save: jest.fn(async (v: Row) => {
        const saved = { ...v, id: `ver-${nextId++}` };
        versions.push(saved);
        return saved;
      }),
      update: jest.fn(async ({ id }: Row, patch: Row) => {
        Object.assign(versions.find((v) => v.id === id) ?? {}, patch);
        return { affected: 1 };
      }),
    };
    const assayers = { update: jest.fn(async () => ({ affected: 1 })), findOne: jest.fn(async () => null) };
    const auditService = { recordEventSafe: jest.fn(async () => undefined) };

    const service = new RosterRecordsService(
      assayers as never, {} as never, {} as never, {} as never, onboarding as never,
      {} as never, {} as never, docVersions as never, auditService as never,
    );
    return { service, documents, versions, assayers, auditService };
  };

  /**
   * A background verification report is produced by an outside agency, and is not accepted without
   * its name — refused before anything is written, so nothing is left half-attached.
   */
  it('refuses a background verification report with no agency, writing nothing', async () => {
    const ctx = harness();
    await expect(ctx.service.attachFile('as-1', OnboardingDocument.BGV_REPORT, 'uploads/bgv.pdf', 'hr-1'))
      .rejects.toThrow(/Name the agency/);
    await expect(ctx.service.attachFile('as-1', OnboardingDocument.BGV_REPORT, 'uploads/bgv.pdf', 'hr-1', undefined, '   '))
      .rejects.toThrow(/Name the agency/);
    expect(ctx.documents).toHaveLength(0);
    expect(ctx.versions).toHaveLength(0);
  });

  it('keeps the agency with the report, and asks no agency of any other document', async () => {
    const ctx = harness();
    await ctx.service.attachFile('as-1', OnboardingDocument.BGV_REPORT, 'uploads/bgv.pdf', 'hr-1', undefined, ' AuthBridge ');
    expect(ctx.documents[0].issuedBy).toBe('AuthBridge');

    await expect(ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1')).resolves.toBeDefined();
  });

  it('files a scan it already holds only once, however often promotion is retried', async () => {
    const ctx = harness();
    await ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1');
    await ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1');
    await ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1');

    expect(ctx.versions.map((v) => [v.filePath, v.version])).toEqual([['uploads/pan.png', 1]]);
    expect(ctx.versions[0].supersededByVersionId).toBeNull();
    expect(ctx.documents[0].filePaths).toEqual(['uploads/pan.png']);
    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledTimes(1);
  });

  it('still files a genuinely new page as the next version', async () => {
    const ctx = harness();
    await ctx.service.attachFile('as-1', OnboardingDocument.AADHAAR_FRONT, 'uploads/a1.png', 'hr-1');
    await ctx.service.attachFile('as-1', OnboardingDocument.AADHAAR_FRONT, 'uploads/a2.png', 'hr-1');

    expect(ctx.versions.map((v) => [v.filePath, v.version])).toEqual([['uploads/a1.png', 1], ['uploads/a2.png', 2]]);
    expect(ctx.documents[0].filePaths).toEqual(['uploads/a1.png', 'uploads/a2.png']);
  });

  it('does not refile either of two photographs, and leaves the latest one on the person', async () => {
    const ctx = harness();
    for (let attempt = 0; attempt < 2; attempt++) {
      await ctx.service.attachFile('as-1', OnboardingDocument.PHOTOGRAPH, 'uploads/face-1.jpg', 'hr-1');
      await ctx.service.attachFile('as-1', OnboardingDocument.PHOTOGRAPH, 'uploads/face-2.jpg', 'hr-1');
    }

    expect(ctx.versions.map((v) => v.filePath)).toEqual(['uploads/face-1.jpg', 'uploads/face-2.jpg']);
    expect(ctx.documents[0].filePaths).toEqual(['uploads/face-2.jpg']);
    expect(ctx.assayers.update).toHaveBeenLastCalledWith({ id: 'as-1' }, { photograph: 'uploads/face-2.jpg', updatedBy: 'hr-1' });
  });

  /**
   * The copy of the face on the person is the last write of an attach, so it is the one a failure
   * can leave undone behind a filed scan — and a retry that skipped the scan must not skip it too,
   * or the ID card prints "Photo unavailable" for somebody whose photograph is on file.
   */
  it('puts the photograph on the person on the retry, when that was the write that failed', async () => {
    const ctx = harness();
    ctx.assayers.update.mockRejectedValueOnce(new Error('connection reset'));
    await expect(ctx.service.attachFile('as-1', OnboardingDocument.PHOTOGRAPH, 'uploads/face.jpg', 'hr-1'))
      .rejects.toThrow('connection reset');

    await ctx.service.attachFile('as-1', OnboardingDocument.PHOTOGRAPH, 'uploads/face.jpg', 'hr-1');

    expect(ctx.versions).toHaveLength(1);
    // Twice: the write that failed, and the retry's — not the failed one alone.
    expect(ctx.assayers.update).toHaveBeenCalledTimes(2);
    expect(ctx.assayers.update).toHaveBeenLastCalledWith({ id: 'as-1' }, { photograph: 'uploads/face.jpg', updatedBy: 'hr-1' });
  });

  /** Somebody checked the scan between the two attempts; the retry is not a new scan. */
  it('keeps a verification made between the attempts', async () => {
    const ctx = harness();
    await ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1');
    ctx.documents[0].verificationStatus = DocumentVerification.VERIFIED;

    await ctx.service.attachFile('as-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'hr-1');
    expect(ctx.documents[0].verificationStatus).toBe(DocumentVerification.VERIFIED);
  });
});
