import { canOpenPapers, openBranchPapers, papersBeingPrepared, type PacketDeps } from './packet';

const ready = { state: 'READY' as const, dispatchedCount: 1, message: '' };
const preparing = { state: 'PREPARING' as const, dispatchedCount: 0, message: '' };

describe('when the Today tab offers the branch papers (same rule as the old app)', () => {
  it.each(['CHECKED_IN', 'IN_PROGRESS'] as const)('offers them on a %s job once they have been sent', (status) => {
    expect(canOpenPapers({ status, documentReadiness: ready })).toBe(true);
  });

  it.each(['PENDING', 'ACCEPTED', 'COMPLETED', 'CANCELLED', 'REJECTED'] as const)('does not offer them on a %s job', (status) => {
    expect(canOpenPapers({ status, documentReadiness: ready })).toBe(false);
  });

  it('does not offer them before they are sent, and says they are being prepared', () => {
    expect(canOpenPapers({ status: 'CHECKED_IN', documentReadiness: preparing })).toBe(false);
    expect(papersBeingPrepared({ status: 'CHECKED_IN', documentReadiness: preparing })).toBe(true);
    expect(papersBeingPrepared({ status: 'ACCEPTED', documentReadiness: preparing })).toBe(false);
    expect(canOpenPapers({ status: 'CHECKED_IN' })).toBe(false);
  });
});

describe('opening the branch papers', () => {
  const deps = (over: Partial<PacketDeps> = {}): PacketDeps & Record<string, jest.Mock> => ({
    getBranchDocuments: jest.fn(async () => ({
      success: true,
      data: [{ id: 'master', type: 'CUSTOMER_MASTER_DATA' }, { id: 'pkt', type: 'PRE_FIELD_AUDIT_PDF' }],
    })),
    getDocumentDownloadUrl: jest.fn(async () => ({ ok: true as const, url: 'https://api/documents/pkt/download?token=t' })),
    openURL: jest.fn(async () => true),
    ...over,
  }) as any;

  it('asks for the released list, takes the branch packet (never the master file) and opens its link', async () => {
    const d = deps();
    await expect(openBranchPapers('pb-1', d)).resolves.toEqual({ kind: 'opened' });
    expect(d.getBranchDocuments).toHaveBeenCalledWith('pb-1');
    expect(d.getDocumentDownloadUrl).toHaveBeenCalledWith('pkt');
    expect(d.openURL).toHaveBeenCalledWith('https://api/documents/pkt/download?token=t');
  });

  it('says not sent when the list has no packet', async () => {
    const d = deps({ getBranchDocuments: jest.fn(async () => ({ success: true, data: [] })) });
    await expect(openBranchPapers('pb-1', d)).resolves.toEqual({ kind: 'not-sent' });
    expect(d.openURL).not.toHaveBeenCalled();
  });

  it('says not available when the server refuses the list', async () => {
    const d = deps({ getBranchDocuments: jest.fn(async () => ({ success: false })) });
    await expect(openBranchPapers('pb-1', d)).resolves.toEqual({ kind: 'not-available' });
  });

  it.each([
    ['SESSION_EXPIRED', 'session-ended'],
    ['NOT_AVAILABLE', 'not-available'],
    ['NETWORK', 'failed'],
  ] as const)('maps a %s link refusal to %s', async (reason, kind) => {
    const d = deps({ getDocumentDownloadUrl: jest.fn(async () => ({ ok: false as const, reason, message: 'x' })) });
    await expect(openBranchPapers('pb-1', d)).resolves.toEqual({ kind });
    expect(d.openURL).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const d = deps({ openURL: jest.fn(async () => { throw new Error('no browser'); }) });
    await expect(openBranchPapers('pb-1', d)).resolves.toEqual({ kind: 'failed' });
  });

  it('does nothing without a branch', async () => {
    const d = deps();
    await expect(openBranchPapers(undefined, d)).resolves.toEqual({ kind: 'not-sent' });
    expect(d.getBranchDocuments).not.toHaveBeenCalled();
  });
});
