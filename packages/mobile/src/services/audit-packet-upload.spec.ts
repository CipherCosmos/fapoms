import { uploadScannedAuditPacket } from './audit-packet-upload';
import { MobileApiService } from './api.service';

jest.mock('./api.service', () => ({
  MobileApiService: {
    uploadAuditPdfResumable: jest.fn(),
    uploadCompletedAuditPdf: jest.fn(),
  },
}));

const resumable = MobileApiService.uploadAuditPdfResumable as jest.Mock;
const singleShot = MobileApiService.uploadCompletedAuditPdf as jest.Mock;

const scan = (over: Partial<any> = {}) => ({
  fileName: 'Scan_2026-08-14.pdf',
  pdfUri: 'file:///cache/scan.pdf',
  pages: [{ pageNumber: 1, uri: 'file:///cache/p1.jpg' }],
  pageCount: 1,
  mimeType: 'application/pdf',
  ...over,
});

const pages = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ pageNumber: i + 1, uri: `file:///cache/p${i + 1}.jpg` }));

beforeEach(() => jest.clearAllMocks());

describe('uploading a scanned audit packet', () => {
  describe('when the device assembled a PDF', () => {
    it('sends it as one document over the resumable path', async () => {
      resumable.mockResolvedValue({ success: true });

      const outcome = await uploadScannedAuditPacket('assign-1', scan({ pageCount: 6, pages: pages(6) }));

      // One call, not six. Page-by-page filing produced six unrelated AUDITED_RETURN_PDF rows
      // where the record claimed one document, each completing the assignment separately.
      expect(resumable).toHaveBeenCalledTimes(1);
      expect(singleShot).not.toHaveBeenCalled();
      expect(resumable).toHaveBeenCalledWith('assign-1', 'Scan_2026-08-14.pdf', 'file:///cache/scan.pdf', 'assign-1');
      expect(outcome).toEqual({ kind: 'uploaded', fileName: 'Scan_2026-08-14.pdf', pageCount: 6 });
    });

    it('reports failure with the reason the transport gave', async () => {
      // The reason matters: "Upload stalled at part 3 of 9" tells the assayer to stay put and
      // retry, which a bare "upload failed" does not.
      resumable.mockResolvedValue({ success: false, error: 'Upload stalled at part 3 of 9' });

      expect(await uploadScannedAuditPacket('assign-1', scan())).toEqual({
        kind: 'failed',
        fileName: 'Scan_2026-08-14.pdf',
        error: 'Upload stalled at part 3 of 9',
      });
    });

    it('treats a thrown transport error as a failed upload, not a crash', async () => {
      // A rejection here used to escape into a JSX event handler, where React has nowhere to put
      // it — the assayer would see the modal close with no indication either way.
      resumable.mockRejectedValue(new Error('Network request failed'));

      expect(await uploadScannedAuditPacket('assign-1', scan())).toEqual({
        kind: 'failed',
        fileName: 'Scan_2026-08-14.pdf',
        error: 'Network request failed',
      });
    });
  });

  describe('when no PDF could be assembled', () => {
    it('sends each page and confirms only when every one arrived', async () => {
      singleShot.mockResolvedValue({ success: true });

      const outcome = await uploadScannedAuditPacket(
        'assign-1',
        scan({ pdfUri: null, pages: pages(3), pageCount: 3 }),
      );

      expect(singleShot).toHaveBeenCalledTimes(3);
      expect(outcome).toEqual({ kind: 'pages-uploaded', total: 3 });
    });

    it('numbers multi-page files so a desk can reassemble the order', async () => {
      singleShot.mockResolvedValue({ success: true });

      await uploadScannedAuditPacket('assign-1', scan({ pdfUri: null, pages: pages(2), pageCount: 2 }));

      expect(singleShot.mock.calls.map((c) => c[1])).toEqual([
        'Scan_2026-08-14_p1of2.jpg',
        'Scan_2026-08-14_p2of2.jpg',
      ]);
    });

    it('keeps the confirmed name when there is only one page', async () => {
      singleShot.mockResolvedValue({ success: true });

      await uploadScannedAuditPacket('assign-1', scan({ pdfUri: null }));

      expect(singleShot.mock.calls[0][1]).toBe('Scan_2026-08-14.pdf');
    });

    it('names which pages failed instead of reporting success', async () => {
      // The assayer has to know *which* pages to rescan, and has to find out before leaving the
      // branch. Reporting a partial delivery as a success is how a packet ends up permanently
      // incomplete with nobody aware of it.
      singleShot
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false });

      const outcome = await uploadScannedAuditPacket(
        'assign-1',
        scan({ pdfUri: null, pages: pages(4), pageCount: 4 }),
      );

      expect(outcome).toEqual({ kind: 'pages-partial', total: 4, uploaded: 2, failed: [2, 4] });
    });

    it('counts a page that threw as failed and still sends the rest', async () => {
      singleShot
        .mockRejectedValueOnce(new Error('socket closed'))
        .mockResolvedValueOnce({ success: true });

      const outcome = await uploadScannedAuditPacket(
        'assign-1',
        scan({ pdfUri: null, pages: pages(2), pageCount: 2 }),
      );

      expect(singleShot).toHaveBeenCalledTimes(2);
      expect(outcome).toEqual({ kind: 'pages-partial', total: 2, uploaded: 1, failed: [1] });
    });
  });
});
