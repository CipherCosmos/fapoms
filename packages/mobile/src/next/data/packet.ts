/**
 * The branch's audit papers (the pre-field packet) on the Today tab — the same capability the old
 * app's "Download packet" button gives, through the same two calls:
 *
 *  1. `GET /documents/project-branch/:id/assayer-view` — only paperwork operations has released;
 *  2. `GET /documents/:id/download-token` — a five-minute link the phone's browser opens.
 *
 * The server decides who may open it (an accepted job on this branch, packet dispatched); this only
 * decides when to OFFER it, exactly as the old app does: once the assayer has reached the branch and
 * the job's `documentReadiness` says READY. Pure, for node tests — the screen passes the real calls.
 */
import type { AssayerAssignment } from '../../types/mobile-app';

/** Offer the button: reached the branch (checked in / working) and the packet has been sent. */
export function canOpenPapers(a: Pick<AssayerAssignment, 'status' | 'documentReadiness'>): boolean {
  return (a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS') && a.documentReadiness?.state === 'READY';
}

/** Say "being prepared" instead of a button, on the same jobs, when nothing has been sent yet. */
export function papersBeingPrepared(a: Pick<AssayerAssignment, 'status' | 'documentReadiness'>): boolean {
  return (a.status === 'CHECKED_IN' || a.status === 'IN_PROGRESS') && a.documentReadiness?.state === 'PREPARING';
}

export interface PacketDeps {
  getBranchDocuments(projectBranchId: string): Promise<{ success: boolean; data?: any[] }>;
  getDocumentDownloadUrl(documentId: string): Promise<
    { ok: true; url: string } | { ok: false; reason: 'SESSION_EXPIRED' | 'NOT_AVAILABLE' | 'NETWORK'; message: string }
  >;
  openURL(url: string): Promise<unknown>;
}

export type PacketOutcome =
  | { kind: 'opened' }
  | { kind: 'not-sent' }
  | { kind: 'not-available' }
  | { kind: 'session-ended' }
  | { kind: 'failed' };

/**
 * Find the branch's own packet and hand its short-lived link to the phone. Only the pre-field
 * packet — never the client's master file, which covers every branch that day (the server
 * withholds it anyway).
 */
export async function openBranchPapers(projectBranchId: string | null | undefined, deps: PacketDeps): Promise<PacketOutcome> {
  if (!projectBranchId) return { kind: 'not-sent' };
  try {
    const list = await deps.getBranchDocuments(projectBranchId);
    if (!list.success) return { kind: 'not-available' };
    const doc = (list.data ?? []).find((d: any) => d?.type === 'PRE_FIELD_AUDIT_PDF');
    if (!doc?.id) return { kind: 'not-sent' };
    const link = await deps.getDocumentDownloadUrl(doc.id);
    if (!link.ok) {
      if (link.reason === 'SESSION_EXPIRED') return { kind: 'session-ended' };
      if (link.reason === 'NETWORK') return { kind: 'failed' };
      return { kind: 'not-available' };
    }
    await deps.openURL(link.url);
    return { kind: 'opened' };
  } catch {
    return { kind: 'failed' };
  }
}
