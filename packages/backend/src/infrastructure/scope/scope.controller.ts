/**
 * FAPOMS — Global Scope Options
 *
 * One call that fills every dropdown in the header's global filter: projects, clients,
 * regions, zones and states. It exists as a single endpoint rather than five because the
 * header mounts on every page — five round trips on every cold load, to render one toolbar,
 * is not a trade worth making.
 *
 * Every list is narrowed by the caller's own scope. A region-restricted operator does not
 * see other regions listed as choices, and the states and zones they are offered are only
 * those that actually contain branches they can open — an option that returns an empty
 * screen is worse than no option at all.
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Region, REGION_ORDER, REGION_LABELS } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, Roles } from '../../modules/auth/guards';
import { STAFF_ROLES } from '../../modules/auth/staff-roles';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { ZoneEntity } from '../../modules/zone/zone.entity';
import { ClientEntity } from '../../modules/client/client.entity';
import { ProjectEntity } from '../../modules/project/project.entity';
import { GlobalScope, GlobalScopeFilter } from './global-scope';

@ApiTags('Scope')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...STAFF_ROLES)
@Controller('scope')
export class ScopeController {
  constructor(
    @InjectRepository(BranchEntity) private readonly branches: Repository<BranchEntity>,
    @InjectRepository(ZoneEntity) private readonly zones: Repository<ZoneEntity>,
    @InjectRepository(ClientEntity) private readonly clients: Repository<ClientEntity>,
    @InjectRepository(ProjectEntity) private readonly projects: Repository<ProjectEntity>,
  ) {}

  @Get('options')
  @ApiOperation({ summary: 'Options for the global scope filter, narrowed to the caller' })
  async options(@GlobalScopeFilter() scope: GlobalScope) {
    const allowed = scope.regions;

    // Regions and states, counted from live branch data so nothing empty is offered.
    const facetQuery = () => {
      const q = this.branches.createQueryBuilder('branch')
        .where('branch.is_active = :isActive', { isActive: true });
      if (allowed && allowed.length > 0) {
        q.andWhere('branch.region IN (:...allowed)', { allowed });
      }
      return q;
    };

    const [regionRows, stateRows, zoneRows, clientRows, projectRows] = await Promise.all([
      facetQuery()
        .select('branch.region', 'value')
        .addSelect('COUNT(*)', 'count')
        .andWhere('branch.region IS NOT NULL')
        .groupBy('branch.region')
        .getRawMany<{ value: string; count: string }>(),

      // Grouped case-insensitively. This column holds 'Maharashtra' and 'MAHARASHTRA' side by
      // side, from different import sources; grouping on the raw value would offer both as
      // rival options, each showing part of the state's branches, with nothing on screen to
      // say why. One option per real state, labelled with the most common spelling.
      facetQuery()
        .select('UPPER(branch.state)', 'key')
        .addSelect('MODE() WITHIN GROUP (ORDER BY branch.state)', 'value')
        .addSelect('MIN(branch.region)', 'region')
        .addSelect('COUNT(*)', 'count')
        .andWhere('branch.state IS NOT NULL')
        .groupBy('UPPER(branch.state)')
        .orderBy('MODE() WITHIN GROUP (ORDER BY branch.state)', 'ASC')
        .getRawMany<{ value: string; region: string | null; count: string }>(),

      // Zones are offered only where the caller can actually see branches in them.
      facetQuery()
        .select('branch.zone_id', 'zoneId')
        .andWhere('branch.zone_id IS NOT NULL')
        .groupBy('branch.zone_id')
        .getRawMany<{ zoneId: string }>(),

      this.clients.find({ where: { isActive: true }, select: ['id', 'name', 'clientCode'], order: { name: 'ASC' } }),

      this.projects.find({
        where: { isActive: true },
        select: ['id', 'name', 'projectNumber', 'clientId'],
        order: { projectNumber: 'ASC' },
      }),
    ]);

    const visibleZoneIds = zoneRows.map((z) => z.zoneId);
    const zones = visibleZoneIds.length
      ? await this.zones.find({ where: { id: In(visibleZoneIds) } })
      : [];

    const counts = new Map(regionRows.map((r) => [r.value, Number(r.count)]));
    // Ordered geographically and filtered to what the caller holds, so the dropdown reads
    // like a map legend rather than an alphabetical list with gaps.
    const regions = REGION_ORDER
      .filter((r) => (!allowed || allowed.includes(r)) && counts.has(r))
      .map((r) => ({ value: r, label: REGION_LABELS[r], count: counts.get(r) ?? 0 }));

    return {
      success: true,
      data: {
        /** Null when the account holds every region; an array when it is assigned a subset. */
        assignedRegions: allowed as Region[] | null,
        regions,
        states: stateRows.map((s) => ({
          value: s.value,
          region: s.region,
          count: Number(s.count),
        })),
        zones: zones
          .map((z) => ({ id: z.id, name: z.name, clientId: z.clientId }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        clients: clientRows.map((c) => ({ id: c.id, name: c.name, clientCode: c.clientCode })),
        projects: projectRows.map((p) => ({
          id: p.id,
          name: p.name,
          projectNumber: p.projectNumber,
          clientId: p.clientId,
        })),
      },
    };
  }
}
