import { MobileApiService } from './api.service';
import type { ScannedDocument } from '../components/DocumentScanner';

/**
 * What happened to a scanned audit packet, as a value rather than a sequence of alerts.
 *
 * This orchestration used to live inline in the scanner modal's `onSaved` handler in App.tsx:
 * eighty lines of transport decisions, retry semantics and partial-failure accounting written
 * between two JSX tags, where it could not be tested and could not be read next to the rest of
 * the upload code it belonged with. Returning an outcome instead of firing alerts is what makes
 * the split possible — the caller keeps deciding how to speak to the assayer, which is a screen
 * concern, while everything about *what to send and whether it arrived* lives here.
 */
export type AuditPacketOutcome =
  /** The assembled PDF went up as a single document — the normal path. */
  | { kind: 'uploaded'; fileName: string; pageCount: number }
  | { kind: 'failed'; fileName: string; error?: string }
  /** Image fallback: every page arrived. */
  | { kind: 'pages-uploaded'; total: number }
  /** Image fallback: some pages did not. `failed` holds their 1-based page numbers. */
  | { kind: 'pages-partial'; total: number; uploaded: number; failed: number[] };

/**
 * Send a completed audit packet for one assignment.
 *
 * Two shapes arrive here. ML Kit assembles the pages into a single PDF on-device, and that is
 * what should reach the desk: filing page-by-page previously produced N unrelated
 * `AUDITED_RETURN_PDF` rows named `..._p1of6.jpg` — six loose JPEGs where the record claimed one
 * document, each triggering its own assignment completion. Where no PDF could be built (iOS, web)
 * the pages go individually, and a partial delivery is reported as partial: a half-delivered
 * evidence packet that announces success is worse than one that fails loudly, because the assayer
 * drives away believing the branch is done.
 *
 * The PDF path is resumable. This is the upload that matters and the worst place to be when it
 * fails — a multi-megabyte scan going out over rural mobile data at the end of a branch visit —
 * so a dropped signal costs only the unsent chunks.
 */
export async function uploadScannedAuditPacket(
  assignmentId: string,
  doc: ScannedDocument,
): Promise<AuditPacketOutcome> {
  if (doc.pdfUri) {
    const res = await MobileApiService.uploadAuditPdfResumable(
      assignmentId,
      doc.fileName,
      doc.pdfUri,
      assignmentId,
    ).catch((err: any) => ({ success: false, error: err?.message }));

    return res?.success
      ? { kind: 'uploaded', fileName: doc.fileName, pageCount: doc.pageCount }
      : { kind: 'failed', fileName: doc.fileName, error: (res as any)?.error };
  }

  const total = doc.pages.length;
  const failed: number[] = [];

  for (const page of doc.pages) {
    // Single-page scans keep the name the assayer confirmed; multi-page ones are numbered so a
    // desk reviewing loose images can still tell what order they came in.
    const base = doc.fileName.replace(/\.[^.]+$/, '');
    const name = total === 1 ? doc.fileName : `${base}_p${page.pageNumber}of${total}.jpg`;
    try {
      const res = await MobileApiService.uploadCompletedAuditPdf(
        assignmentId,
        name,
        { uri: page.uri },
        assignmentId,
      );
      if (!res?.success) failed.push(page.pageNumber);
    } catch {
      failed.push(page.pageNumber);
    }
  }

  return failed.length === 0
    ? { kind: 'pages-uploaded', total }
    : { kind: 'pages-partial', total, uploaded: total - failed.length, failed };
}
