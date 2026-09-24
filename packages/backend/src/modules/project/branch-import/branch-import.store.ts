/**
 * FAPOMS — the branch import's one door to the database.
 *
 * Everything the rehearsal and the commit read or write goes through here, in as few statements as
 * the work allows: the master for a whole file in one query, a chunk of 200 branches in one
 * transaction with multi-row inserts, and each branch's audit entry inside the same transaction as
 * the change it records (so a rolled-back chunk leaves no entry claiming it happened).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository, type EntityManager } from 'typeorm';
import { EventCategory, Priority, ProjectBranchStatus, zoneNameForState } from '@fapoms/shared';
import { BranchEntity } from '../../branch/branch.entity';
import { BranchService } from '../../branch/branch.service';
import { ClientEntity } from '../../client/client.entity';
import { ZoneEntity } from '../../zone/zone.entity';
import { ProjectEntity } from '../project.entity';
import { ProjectBranchEntity } from '../project-branch.entity';
import { AssessmentEntity } from '../assessment.entity';
import { AuditService } from '../../../core/audit/audit.service';
import { DomainEventPublisher } from '../../../core/events/domain-event.publisher';
import { resolveBankCode } from '../../geo/ifsc-lookup.helper';
import type { ChunkToWrite, CommitStore } from './branch-import.commit';
import type { RehearsalReads } from './branch-import.rehearsal';
import type { BranchImportScopeType, BranchImportTarget, MasterBranch, OtherClientBranch } from './branch-import.types';

const MASTER_COLUMNS: Array<keyof BranchEntity> = [
  'id', 'solId', 'name', 'state', 'district', 'city', 'address', 'pincode', 'latitude', 'longitude',
  'geoSource', 'geoAccuracyMeters', 'region', 'zoneId', 'isActive', 'complexity', 'estimatedDurationHours',
];

function toMaster(b: BranchEntity): MasterBranch {
  return {
    id: b.id,
    solId: b.solId,
    name: b.name,
    state: b.state ?? null,
    district: b.district ?? null,
    city: b.city ?? null,
    address: b.address ?? null,
    pincode: b.pincode ?? null,
    latitude: b.latitude === null || b.latitude === undefined ? null : Number(b.latitude),
    longitude: b.longitude === null || b.longitude === undefined ? null : Number(b.longitude),
    geoSource: b.geoSource ?? null,
    geoAccuracyMeters: b.geoAccuracyMeters ?? null,
    region: b.region ?? null,
    zoneId: b.zoneId ?? null,
    isActive: b.isActive !== false,
    complexity: b.complexity ?? null,
    estimatedDurationHours: b.estimatedDurationHours === null || b.estimatedDurationHours === undefined
      ? null : Number(b.estimatedDurationHours),
  };
}

@Injectable()
export class BranchImportStore {
  constructor(
    @InjectRepository(BranchEntity) private readonly branches: Repository<BranchEntity>,
    @InjectRepository(ProjectBranchEntity) private readonly links: Repository<ProjectBranchEntity>,
    @InjectRepository(AssessmentEntity) private readonly assessments: Repository<AssessmentEntity>,
    @InjectRepository(ClientEntity) private readonly clients: Repository<ClientEntity>,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(ZoneEntity) private readonly zones: Repository<ZoneEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly branchService: BranchService,
    private readonly audit: AuditService,
    private readonly events: DomainEventPublisher,
  ) {}

  /**
   * The client (and project) an import loads into. A missing one is a 404 in the request, never a
   * job that fails later — and a client-scoped import always names its client: an empty client id
   * used to match every client's branches.
   */
  async resolveTarget(scopeType: BranchImportScopeType, id: string): Promise<BranchImportTarget> {
    let project: ProjectEntity | null = null;
    let clientId: string | null = id;
    if (scopeType === 'PROJECT') {
      project = await this.projects.findOne({ where: { id } });
      if (!project) throw new NotFoundException('That project was not found, so there is nothing to import these branches into.');
      clientId = project.clientId ?? null;
    }
    const client = clientId ? await this.clients.findOne({ where: { id: clientId } }) : null;
    if (scopeType === 'CLIENT' && !client) {
      throw new NotFoundException('That client was not found, so there is nothing to import these branches into.');
    }
    const clientName = client?.name || client?.displayName || '';
    const minutes = Number(client?.planningPreferences?.minutesPerPacket);
    return {
      scopeType,
      projectId: project?.id ?? null,
      clientId: client?.id ?? null,
      organizationId: project?.organizationId ?? client?.organizationId ?? null,
      clientName,
      bankCode: resolveBankCode(clientName) || resolveBankCode(client?.clientCode),
      priority: String(project?.priority || Priority.MEDIUM),
      minutesPerPacket: Number.isFinite(minutes) && minutes > 0 ? minutes : 15,
      label: project ? `${project.name} (${project.projectNumber})` : clientName || 'this client',
    };
  }

  /** The regions this client's branches with these SOL IDs sit in now — one query. */
  async regionsOfKnownBranches(clientId: string | null, solIds: string[]): Promise<string[]> {
    if (!clientId || solIds.length === 0) return [];
    const rows: Array<{ region: string | null }> = await this.dataSource.query(
      `SELECT DISTINCT region FROM branches WHERE client_id = $1 AND sol_id = ANY($2) AND region IS NOT NULL`,
      [clientId, [...new Set(solIds.map((s) => s.trim()))]],
    );
    return rows.map((r) => r.region!).filter(Boolean);
  }

  readsFor(target: BranchImportTarget): RehearsalReads {
    return {
      masterBySol: (solIds) => this.masterBySol(target, solIds),
      otherClientsBySol: async (solIds): Promise<OtherClientBranch[]> => {
        const rows: Array<{ sol_id: string; client_id: string | null; client_name: string | null; name: string }> =
          await this.dataSource.query(
            `SELECT b.sol_id, b.client_id, c.name AS client_name, b.name
               FROM branches b LEFT JOIN clients c ON c.id = b.client_id
              WHERE b.sol_id = ANY($1) AND b.client_id IS DISTINCT FROM $2`,
            [[...new Set(solIds.map((s) => s.trim()))], target.clientId],
          );
        return rows.map((r) => ({ solId: r.sol_id, clientId: r.client_id, clientName: r.client_name, name: r.name }));
      },
      validateGeography: (state, district, city) => this.branchService.assertGeographyVerifiable(state, district, city),
    };
  }

  commitStoreFor(target: BranchImportTarget): CommitStore {
    return {
      masterBySol: (solIds) => this.masterBySol(target, solIds),
      projectLinks: async (projectId) =>
        (await this.links.find({ where: { projectId, isActive: true }, select: ['id', 'branchId', 'packetCount'] }))
          .map((l) => ({ id: l.id, branchId: l.branchId, packetCount: l.packetCount ?? null })),
      assessedBranchIds: async (projectId) =>
        (await this.assessments.find({ where: { projectId, isActive: true }, select: ['id', 'branchId'] })).map((a) => a.branchId),
      zoneIdForState: (state) => this.zoneIdForState(target, state),
      validateGeography: (state, district, city) => this.branchService.assertGeographyVerifiable(state, district, city),
      writeChunk: (chunk) => this.writeChunk(chunk),
      announce: (t, count) => this.announce(t, count),
    };
  }

  /** One entry for the whole import, on the client or project it was loaded into. */
  async recordImportSummary(target: BranchImportTarget, userId: string, jobId: string, remarks: string, counts: Record<string, number>): Promise<void> {
    await this.audit.recordEventSafe({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_IMPORT_COMMITTED',
      entityType: target.projectId ? 'PROJECT' : 'CLIENT',
      entityId: target.projectId ?? target.clientId!,
      userId,
      remarks,
      metadata: { backgroundJobId: jobId, ...counts },
    });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────

  private async masterBySol(target: BranchImportTarget, solIds: string[]): Promise<MasterBranch[]> {
    const sols = [...new Set(solIds.map((s) => s.trim()).filter(Boolean))];
    if (sols.length === 0) return [];
    // Archived rows included on purpose: a branch the client's list still names is brought back,
    // never duplicated beside its archived self.
    const found = await this.branches.find({
      where: { solId: In(sols), ...(target.clientId ? { clientId: target.clientId } : {}) },
      select: MASTER_COLUMNS,
    });
    return found.map(toMaster);
  }

  /** The zone a client keeps for this state, or the default zone for its region (created once). */
  private async zoneIdForState(target: BranchImportTarget, state: string): Promise<string | null> {
    if (!target.clientId || !state) return null;
    const key = state.toUpperCase();
    const zones = await this.zones.createQueryBuilder('zone')
      .where('zone.isActive = true')
      .andWhere('(zone.clientId = :clientId OR zone.clientId IS NULL)', { clientId: target.clientId })
      .getMany();
    const claimed = zones.find((z) => Array.isArray(z.states) && z.states.some((s) => s.toUpperCase() === key));
    const name = claimed?.name ?? zoneNameForState(state) ?? 'East Zone';
    const zone = await this.branchService.findOrCreateZone(name, target.clientId, [key]);
    return zone?.id ?? null;
  }

  private async writeChunk(chunk: ChunkToWrite): Promise<Map<number, string>> {
    const { rows, target, userId, jobId } = chunk;
    return this.dataSource.transaction(async (manager) => {
      const ids = new Map<number, string>();

      const creates = rows.filter((r) => r.create);
      if (creates.length > 0) {
        const inserted = await manager.insert(BranchEntity, creates.map((r) => ({ ...r.create!, isActive: true })) as any[]);
        inserted.identifiers.forEach((identifier, i) => ids.set(creates[i].rowNumber, String(identifier.id)));
      }

      const restores = rows.filter((r) => r.existing?.restore).map((r) => r.existing!.branchId);
      if (restores.length > 0) {
        await manager.update(BranchEntity, { id: In(restores) }, { isActive: true, updatedBy: userId });
      }
      for (const r of rows) {
        if (!r.existing) continue;
        ids.set(r.rowNumber, r.existing.branchId);
        if (Object.keys(r.existing.patch).length > 0) {
          await manager.update(BranchEntity, { id: r.existing.branchId }, { ...r.existing.patch, updatedBy: userId } as any);
        }
      }

      if (target.projectId) await this.writeLinks(manager, chunk, ids);
      await this.writeAudit(manager, chunk, ids, jobId);
      return ids;
    });
  }

  private async writeLinks(manager: EntityManager, chunk: ChunkToWrite, ids: Map<number, string>): Promise<void> {
    const { rows, target, userId } = chunk;
    const newLinks = rows.filter((r) => r.link?.create && ids.has(r.rowNumber));
    if (newLinks.length > 0) {
      await manager.insert(ProjectBranchEntity, newLinks.map((r) => ({
        projectId: target.projectId!,
        branchId: ids.get(r.rowNumber)!,
        zoneId: r.create?.zoneId ?? r.existing?.zoneId ?? null,
        status: ProjectBranchStatus.IMPORTED,
        packetCount: r.link!.packetCount,
        // Inherits the project's priority, which assignments then take from this row.
        priority: target.priority as Priority,
        createdBy: userId,
        updatedBy: userId,
      })));
      const toAssess = newLinks.filter((r) => r.link!.openAssessment);
      if (toAssess.length > 0) {
        await manager.insert(AssessmentEntity, toAssess.map((r) => ({
          projectId: target.projectId!,
          branchId: ids.get(r.rowNumber)!,
          createdBy: userId,
          updatedBy: userId,
        })));
      }
    }
    for (const r of rows) {
      if (r.link && !r.link.create && r.link.linkId) {
        await manager.update(ProjectBranchEntity, { id: r.link.linkId }, { packetCount: r.link.packetCount, updatedBy: userId });
      }
    }
  }

  /** Each branch keeps its own history — created, corrected, restored — written with the change. */
  private async writeAudit(manager: EntityManager, chunk: ChunkToWrite, ids: Map<number, string>, jobId: string): Promise<void> {
    const { rows, userId } = chunk;
    for (const r of rows) {
      const branchId = ids.get(r.rowNumber);
      if (!branchId) continue;
      const metadata = { backgroundJobId: jobId, row: r.rowNumber };
      if (r.create) {
        await this.audit.recordEvent({
          category: EventCategory.OPERATIONAL, eventType: 'BRANCH_CREATED', entityType: 'BRANCH', entityId: branchId, userId,
          remarks: `Created branch ${r.name} (${r.solId}) from a branch import`, metadata,
        }, { manager });
        continue;
      }
      if (r.existing?.restore) {
        await this.audit.recordEvent({
          category: EventCategory.OPERATIONAL, eventType: 'BRANCH_RESTORED', entityType: 'BRANCH', entityId: branchId, userId,
          remarks: `Restored archived branch ${r.name} (${r.solId}) — named again by an import.`, metadata,
        }, { manager });
      }
      const fields = Object.keys(r.existing?.patch ?? {}).filter((f) => f !== 'location');
      if (fields.length > 0) {
        await this.audit.recordEvent({
          category: EventCategory.OPERATIONAL, eventType: 'BRANCH_UPDATED', entityType: 'BRANCH', entityId: branchId, userId,
          remarks: `Updated branch ${r.name} (${r.solId}) from a branch import: ${fields.join(', ')}`,
          metadata: { ...metadata, fields },
        }, { manager });
      }
    }
  }

  /**
   * One `branch:updated` notice per chunk, not per row. Open Branches pages and the planning queue
   * refetch on it; 5,000 of them in a minute was every open screen refetching 5,000 times.
   */
  private announce(target: BranchImportTarget, count: number): void {
    try {
      this.events.publish('branch:updated', {
        eventType: 'branch:updated',
        branchId: null,
        bulk: true,
        count,
        clientId: target.clientId,
        organizationId: target.organizationId,
        timestamp: new Date(),
      });
    } catch {
      // Advisory: a screen that missed it refetches on its next load.
    }
  }
}
