import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { SecurityIncidentEntity } from './security-incident.entity';
import { computeIncidentClocks, type IncidentClocks } from './incident-clocks';

export const INCIDENT_CATEGORIES = [
  'UNAUTHORISED_ACCESS', 'DATA_BREACH', 'MALWARE', 'DOS', 'PHISHING',
  'SYSTEM_COMPROMISE', 'IDENTITY_THEFT', 'OTHER',
] as const;
export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const INCIDENT_STATUSES = ['OPEN', 'CONTAINED', 'RESOLVED', 'CLOSED'] as const;

export interface CreateIncidentDto {
  title: string;
  category: string;
  severity: string;
  detectedAt?: string;
  description?: string;
  personalDataInvolved?: boolean;
  affectedDataPrincipals?: number | null;
}

export interface UpdateIncidentDto {
  status?: string;
  description?: string;
  remediation?: string;
  personalDataInvolved?: boolean;
  affectedDataPrincipals?: number | null;
  /** Milestone actions — set the corresponding timestamp to now when true. */
  markCertInReported?: boolean;
  markBoardNotified?: boolean;
  markPrincipalsNotified?: boolean;
}

export type IncidentView = SecurityIncidentEntity & { clocks: IncidentClocks };

/**
 * The security-incident register and its two statutory clocks.
 *
 * Every create and material update is itself audited (into the same immutable trail the incident may
 * be about), so the response to an incident has its own evidence. The clocks are computed on read —
 * never stored — so "hours remaining" is always live rather than a stale snapshot.
 */
@Injectable()
export class SecurityIncidentService {
  constructor(
    @InjectRepository(SecurityIncidentEntity)
    private readonly repo: Repository<SecurityIncidentEntity>,
    private readonly audit: AuditService,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {}

  async create(dto: CreateIncidentDto, actorId: string | null): Promise<IncidentView> {
    if (!dto.title?.trim()) throw new BadRequestException('title is required.');
    if (!INCIDENT_CATEGORIES.includes(dto.category as any)) throw new BadRequestException('Unknown category.');
    if (!INCIDENT_SEVERITIES.includes(dto.severity as any)) throw new BadRequestException('Unknown severity.');

    const row = this.repo.create({
      title: dto.title.trim(),
      category: dto.category,
      severity: dto.severity,
      status: 'OPEN',
      description: dto.description ?? null,
      detectedAt: dto.detectedAt ? new Date(dto.detectedAt) : new Date(),
      personalDataInvolved: !!dto.personalDataInvolved,
      affectedDataPrincipals: dto.affectedDataPrincipals ?? null,
      createdBy: actorId,
    });
    const saved = await this.repo.save(row);

    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'SECURITY_INCIDENT_RAISED',
      entityType: 'SECURITY_INCIDENT',
      entityId: saved.id,
      userId: actorId ?? undefined,
      remarks: `${saved.severity} ${saved.category}: ${saved.title}`,
      metadata: { personalDataInvolved: saved.personalDataInvolved },
    });

    this.notificationDispatch.emitSafe({
      type: 'SECURITY_INCIDENT_RAISED',
      entityType: 'SECURITY_INCIDENT',
      entityId: saved.id,
      actorUserId: actorId,
      payload: { severity: saved.severity, category: saved.category, title: saved.title },
    });

    return this.toView(saved);
  }

  async list(): Promise<IncidentView[]> {
    const rows = await this.repo.find({ order: { detectedAt: 'DESC' }, take: 500 });
    return rows.map((r) => this.toView(r));
  }

  async get(id: string): Promise<IncidentView> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Incident not found.');
    return this.toView(row);
  }

  async update(id: string, dto: UpdateIncidentDto, actorId: string | null): Promise<IncidentView> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Incident not found.');

    if (dto.status !== undefined) {
      if (!INCIDENT_STATUSES.includes(dto.status as any)) throw new BadRequestException('Unknown status.');
      row.status = dto.status;
      if ((dto.status === 'RESOLVED' || dto.status === 'CLOSED') && !row.resolvedAt) row.resolvedAt = new Date();
    }
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.remediation !== undefined) row.remediation = dto.remediation;
    if (dto.personalDataInvolved !== undefined) row.personalDataInvolved = dto.personalDataInvolved;
    if (dto.affectedDataPrincipals !== undefined) row.affectedDataPrincipals = dto.affectedDataPrincipals;

    // Milestones are one-way and stamped at the moment they are recorded.
    const milestones: string[] = [];
    if (dto.markCertInReported && !row.certInReportedAt) { row.certInReportedAt = new Date(); milestones.push('CERT-In reported'); }
    if (dto.markBoardNotified && !row.boardNotifiedAt) { row.boardNotifiedAt = new Date(); milestones.push('DPDP Board notified'); }
    if (dto.markPrincipalsNotified && !row.principalsNotifiedAt) { row.principalsNotifiedAt = new Date(); milestones.push('Data Principals notified'); }

    const saved = await this.repo.save(row);
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'SECURITY_INCIDENT_UPDATED',
      entityType: 'SECURITY_INCIDENT',
      entityId: saved.id,
      userId: actorId ?? undefined,
      newState: saved.status,
      remarks: milestones.length ? milestones.join('; ') : `updated`,
    });
    return this.toView(saved);
  }

  /** Counts for the compliance-health view: how many are open and how many have missed a clock. */
  async summary(): Promise<{
    total: number; open: number; certInOverdue: number; boardOverdue: number; principalsOverdue: number;
  }> {
    const rows = await this.repo.find({ take: 2000 });
    const now = new Date();
    let open = 0, certInOverdue = 0, boardOverdue = 0, principalsOverdue = 0;
    for (const r of rows) {
      if (r.status === 'OPEN' || r.status === 'CONTAINED') open++;
      const c = computeIncidentClocks(r, now);
      if (c.certIn.overdue) certInOverdue++;
      if (c.dpdpBoard.overdue) boardOverdue++;
      // dpdpPrincipals has no fixed deadline (see incident-clocks.ts) so it cannot be "overdue" in the
      // same sense — "still not done" is the honest signal, counted here as its own thing rather than
      // folded into a field named *Overdue that the other two genuinely earn.
      if (c.dpdpPrincipals.applicable && !c.dpdpPrincipals.satisfied) principalsOverdue++;
    }
    return { total: rows.length, open, certInOverdue, boardOverdue, principalsOverdue };
  }

  private toView(row: SecurityIncidentEntity): IncidentView {
    return Object.assign(row, { clocks: computeIncidentClocks(row) });
  }
}
