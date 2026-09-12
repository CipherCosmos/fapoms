import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InterviewOutcome } from '@fapoms/shared';
import { AssayerInterviewEntity } from './assayer-interview.entity';
import { RegistrationApplicationService } from './registration-application.service';

export interface RecordInterviewDto {
  candidateName: string;
  mobile: string;
  email?: string;
  notes?: string;
  outcome: InterviewOutcome;
}

/**
 * The Appraiser Recruitment spec's Module 1: HR's pre-registration interview gate.
 *
 * A PASS spawns an `AssayerApplicationEntity` and its invite link (`RegistrationApplicationService
 * .createInvite`) — this service owns none of that logic itself, only the record of the interview
 * and the decision to spawn one.
 */
@Injectable()
export class AssayerInterviewService {
  constructor(
    @InjectRepository(AssayerInterviewEntity)
    private readonly interviews: Repository<AssayerInterviewEntity>,
    private readonly registrationApplications: RegistrationApplicationService,
  ) {}

  async record(
    dto: RecordInterviewDto,
    userId: string,
    userName: string | undefined,
    organizationId?: string | null,
  ): Promise<AssayerInterviewEntity> {
    if (!dto.candidateName?.trim()) throw new BadRequestException('Candidate name is required.');
    if (!dto.mobile?.trim()) throw new BadRequestException('Mobile number is required.');

    const interview = this.interviews.create({
      candidateName: dto.candidateName.trim(),
      mobile: dto.mobile.trim(),
      email: dto.email?.trim() || null,
      notes: dto.notes?.trim() || null,
      outcome: dto.outcome,
      interviewedByUserId: userId,
      interviewedByName: userName ?? null,
      interviewedAt: new Date(),
      organizationId: organizationId ?? null,
    });
    const saved = await this.interviews.save(interview);

    if (dto.outcome === InterviewOutcome.PASS) {
      const application = await this.registrationApplications.createInvite({
        interviewId: saved.id,
        fullName: saved.candidateName,
        mobile: saved.mobile,
        email: saved.email,
        organizationId,
      });
      saved.spawnedApplicationId = application.id;
      await this.interviews.save(saved);
    }
    return saved;
  }

  async list(): Promise<AssayerInterviewEntity[]> {
    return this.interviews.find({ order: { interviewedAt: 'DESC' } });
  }
}
