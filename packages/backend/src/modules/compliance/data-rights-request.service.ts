import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { DataRightsRequestEntity } from './data-rights-request.entity';
import { computeSlaClock, type SlaClock } from './sla-clock';

export const RIGHTS_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'GRIEVANCE', 'NOMINATION'] as const;
export const RIGHTS_REQUEST_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'AWAITING_INFO', 'COMPLETED', 'REJECTED'] as const;
const TERMINAL = new Set(['COMPLETED', 'REJECTED']);

/** Industry-standard default: respond to a rights request within 30 days. Overridable in settings. */
const DEFAULT_SLA_DAYS = 30;

export interface CreateRightsRequestDto {
  requestType: string;
  subjectType?: string;
  subjectRef?: string;
  requesterName?: string;
  requesterContact?: string;
  details?: string;
}

export interface UpdateRightsRequestDto {
  status?: string;
  resolutionNotes?: string;
  legalHoldApplied?: boolean;
  subjectId?: string | null;
}

export type RightsRequestView = DataRightsRequestEntity & { sla: SlaClock };

/**
 * The DPDP rights-request register: receive, track against the SLA, and record the resolution — with
 * every material step audited. Erasure is treated as a review against retention duties (see the
 * entity), never an automatic delete.
 */
@Injectable()
export class DataRightsRequestService {
  constructor(
    @InjectRepository(DataRightsRequestEntity)
    private readonly repo: Repository<DataRightsRequestEntity>,
    private readonly audit: AuditService,
    private readonly settings: PlatformSettingsService,
  ) {}

  private async slaDays(): Promise<number> {
    const configured = await this.settings.get<number | null>('dpdp.rightsRequestSlaDays').catch(() => null);
    const n = Number(configured);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA_DAYS;
  }

  async create(dto: CreateRightsRequestDto, actorId: string | null): Promise<RightsRequestView> {
    if (!RIGHTS_REQUEST_TYPES.includes(dto.requestType as any)) throw new BadRequestException('Unknown request type.');
    const row = this.repo.create({
      requestType: dto.requestType,
      subjectType: dto.subjectType && ['ASSAYER', 'USER', 'OTHER'].includes(dto.subjectType) ? dto.subjectType : 'ASSAYER',
      subjectRef: dto.subjectRef ?? null,
      requesterName: dto.requesterName ?? null,
      requesterContact: dto.requesterContact ?? null,
      details: dto.details ?? null,
      status: 'RECEIVED',
      receivedAt: new Date(),
      createdBy: actorId,
    });
    const saved = await this.repo.save(row);
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'DATA_RIGHTS_REQUEST_RECEIVED',
      entityType: 'DATA_RIGHTS_REQUEST',
      entityId: saved.id,
      userId: actorId ?? undefined,
      remarks: `${saved.requestType} request`,
      metadata: { subjectType: saved.subjectType },
    });
    return this.toView(saved, await this.slaDays());
  }

  async list(): Promise<RightsRequestView[]> {
    const [rows, days] = await Promise.all([
      this.repo.find({ order: { receivedAt: 'DESC' }, take: 500 }),
      this.slaDays(),
    ]);
    return rows.map((r) => this.toView(r, days));
  }

  async get(id: string): Promise<RightsRequestView> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Request not found.');
    return this.toView(row, await this.slaDays());
  }

  async update(id: string, dto: UpdateRightsRequestDto, actorId: string | null): Promise<RightsRequestView> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Request not found.');

    if (dto.status !== undefined) {
      if (!RIGHTS_REQUEST_STATUSES.includes(dto.status as any)) throw new BadRequestException('Unknown status.');
      row.status = dto.status;
      if (TERMINAL.has(dto.status) && !row.completedAt) row.completedAt = new Date();
    }
    if (dto.resolutionNotes !== undefined) row.resolutionNotes = dto.resolutionNotes;
    if (dto.legalHoldApplied !== undefined) row.legalHoldApplied = dto.legalHoldApplied;
    if (dto.subjectId !== undefined) row.subjectId = dto.subjectId;

    const saved = await this.repo.save(row);
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'DATA_RIGHTS_REQUEST_UPDATED',
      entityType: 'DATA_RIGHTS_REQUEST',
      entityId: saved.id,
      userId: actorId ?? undefined,
      newState: saved.status,
      remarks: saved.legalHoldApplied ? 'legal-retention hold applied' : undefined,
    });
    return this.toView(saved, await this.slaDays());
  }

  /** Counts for the compliance-health view: open requests and any past their SLA. */
  async summary(): Promise<{ open: number; overdue: number }> {
    const [rows, days] = await Promise.all([this.repo.find({ take: 2000 }), this.slaDays()]);
    const now = new Date();
    let open = 0, overdue = 0;
    for (const r of rows) {
      const terminal = TERMINAL.has(r.status);
      if (!terminal) open++;
      if (!terminal && computeSlaClock(r.receivedAt, days, r.completedAt, now).overdue) overdue++;
    }
    return { open, overdue };
  }

  private toView(row: DataRightsRequestEntity, slaDays: number): RightsRequestView {
    return Object.assign(row, { sla: computeSlaClock(row.receivedAt, slaDays, row.completedAt) });
  }
}
