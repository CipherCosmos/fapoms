import type { EntityManager } from 'typeorm';
import { OnboardingApprovalEventKind, OnboardingApprovalStatus } from '@fapoms/shared';
import { AssayerOnboardingApprovalEntity } from './assayer-onboarding-approval.entity';

/**
 * Open a round of the approval before training, on the caller's transaction.
 *
 * Lives outside both services because both need it: `AssayerService` opens a round whenever
 * somebody enters FINAL_APPROVAL (by whatever road — the record's button, a bulk move, a re-open),
 * and `OnboardingApprovalService` decides it. Neither can depend on the other.
 *
 * Idempotent on an open round: entering approval while one is already open (which the lifecycle
 * itself cannot produce) adds nothing rather than forking the conversation.
 */
export async function openApprovalRound(
  manager: EntityManager,
  assayerId: string,
  submittedBy: string,
  note: string | null,
): Promise<AssayerOnboardingApprovalEntity> {
  const repo = manager.getRepository(AssayerOnboardingApprovalEntity);
  const open = await repo.findOne({
    where: [
      { assayerId, status: OnboardingApprovalStatus.PENDING },
      { assayerId, status: OnboardingApprovalStatus.INFO_REQUESTED },
    ],
  });
  if (open) return open;
  const last = await repo.findOne({ where: { assayerId }, order: { round: 'DESC' } });
  return repo.save(repo.create({
    assayerId,
    round: (last?.round ?? 0) + 1,
    status: OnboardingApprovalStatus.PENDING,
    submittedBy,
    events: [{
      kind: OnboardingApprovalEventKind.SUBMITTED,
      byId: submittedBy,
      byName: null,
      at: new Date().toISOString(),
      text: note?.trim() || null,
    }],
    createdBy: submittedBy,
    updatedBy: submittedBy,
  }));
}
