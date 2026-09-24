import { AssignmentStatus } from '@fapoms/shared';

export interface PacketReadiness {
  state: 'READY' | 'PREPARING' | 'NONE';
  dispatchedCount: number;
  message: string;
}

/**
 * The branch's packet readiness as THIS job's assayer may act on it.
 *
 * The packet is opened only by an assayer who has accepted the job (`assertAssayerMayDownload`),
 * so an offer still waiting for an answer is never told "ready to download" — it is told the
 * paperwork is waiting for them once they accept. Every other status passes through unchanged.
 */
export function pendingOfferReadiness(status: AssignmentStatus | string, readiness: PacketReadiness): PacketReadiness {
  if (status !== AssignmentStatus.PENDING || readiness.state !== 'READY') return readiness;
  return {
    state: 'PREPARING',
    dispatchedCount: 0,
    message: 'The paperwork for this branch is ready. You can open it once you accept the job.',
  };
}
