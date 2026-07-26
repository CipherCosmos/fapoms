import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OperationsExecutionGroupEntity, ExecutionGroupStatus } from './operations-execution-group.entity';
import { OperationsExecutionConversationEntity, NegotiationParticipant } from './operations-execution-conversation.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';

export interface GroupPackageDto {
  assayerId: string;
  name?: string;
  assignmentIds: string[];
  logisticsPreferences?: any;
}

@Injectable()
export class OperationsExecutionService {
  constructor(
    @InjectRepository(OperationsExecutionGroupEntity)
    private readonly groupRepository: Repository<OperationsExecutionGroupEntity>,
    @InjectRepository(OperationsExecutionConversationEntity)
    private readonly conversationRepository: Repository<OperationsExecutionConversationEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
  ) {}

  /**
   * Bundles multiple branches/assignments into a single operational deployment package.
   */
  async packageAssignments(dto: GroupPackageDto): Promise<OperationsExecutionGroupEntity> {
    if (dto.assignmentIds.length === 0) {
      throw new BadRequestException('At least one assignment ID must be provided to create a package.');
    }

    let group = this.groupRepository.create({
      assayerId: dto.assayerId,
      name: dto.name || 'Execution Package Route',
      status: ExecutionGroupStatus.DRAFT,
      logisticsPreferences: dto.logisticsPreferences || {},
    });
    group = await this.groupRepository.save(group);

    // Relate targeted assignment records to the newly created group

    // Mock update execution relation for actual targeted IDs
    for (const aid of dto.assignmentIds) {
      const assignment = await this.assignmentRepository.findOne({ where: { id: aid } });
      if (assignment) {
        assignment.executionGroupId = group.id;
        await this.assignmentRepository.save(assignment);
      }
    }

    return this.groupRepository.findOne({ where: { id: group.id }, relations: ['assignments'] }) as Promise<OperationsExecutionGroupEntity>;
  }

  /**
   * Records a negotiation conversation history message.
   */
  async postConversationMessage(
    groupId: string,
    sender: NegotiationParticipant,
    message: string,
    feeOverride?: number,
    dateOverride?: string
  ): Promise<OperationsExecutionConversationEntity> {
    const group = await this.groupRepository.findOne({ where: { id: groupId } });
    if (!group) {
      throw new NotFoundException(`Execution group ${groupId} not found.`);
    }

    const msg = this.conversationRepository.create({
      groupId,
      sender,
      message,
      proposedFeeOverride: feeOverride || null,
      proposedDateOverride: dateOverride || null,
    });
    await this.conversationRepository.save(msg);

    // Update group status to NEGOTIATION if negotiation updates occur
    if (sender === NegotiationParticipant.ASSAYER) {
      group.status = ExecutionGroupStatus.DISPATCHED; // Mapped state flag updates
      await this.groupRepository.save(group);
    }

    return msg;
  }

  /**
   * Evaluates operational readiness compliance of an execution package.
   */
  async evaluateOperationalReadiness(groupId: string): Promise<{ isReady: boolean; checks: Record<string, boolean> }> {
    const group = await this.groupRepository.findOne({ where: { id: groupId }, relations: ['assignments'] });
    if (!group) {
      throw new NotFoundException(`Execution group ${groupId} not found.`);
    }

    const checks = {
      assayerConfirmed: group.status === ExecutionGroupStatus.CONFIRMED || group.status === ExecutionGroupStatus.READY,
      hasAssignments: group.assignments && group.assignments.length > 0,
      commercialApproved: group.totalFee !== null,
    };

    const isReady = Object.values(checks).every((v) => v === true);
    return {
      isReady,
      checks,
    };
  }
}
