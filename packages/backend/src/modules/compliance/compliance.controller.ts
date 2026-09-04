import {
  Controller, Get, Post, Patch, Body, Param, Req, UseGuards, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SystemRole } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { AuditSealService } from '../../core/audit/audit-seal.service';
import {
  SecurityIncidentService, type CreateIncidentDto, type UpdateIncidentDto,
} from './security-incident.service';
import {
  DataRightsRequestService, type CreateRightsRequestDto, type UpdateRightsRequestDto,
} from './data-rights-request.service';

/**
 * The compliance operations surface: the security-incident register (with its CERT-In 6-hour and
 * DPDP 72-hour clocks) and a one-call health summary of the compliance machinery.
 *
 * Administrators run it; auditors read it. Reads are open to both; the writes that raise or move an
 * incident are administrators' — and are themselves audited into the immutable trail.
 */
@ApiTags('Compliance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('admin/compliance')
export class ComplianceController {
  constructor(
    private readonly incidents: SecurityIncidentService,
    private readonly rights: DataRightsRequestService,
    private readonly auditSeal: AuditSealService,
  ) {}

  /**
   * A single signal for "is the compliance machinery healthy and are any deadlines slipping".
   * `auditUnsealed` should sit near zero (the sealer keeps the hash chain current); a growing value
   * means sealing has fallen behind. The incident counts surface any statutory clock already missed.
   */
  @Get('health')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'Compliance health: audit-chain sealing backlog and incident deadlines' })
  async health() {
    const [auditUnsealed, incidents, rightsRequests] = await Promise.all([
      this.auditSeal.unsealedCount(),
      this.incidents.summary(),
      this.rights.summary(),
    ]);
    return { success: true, data: { auditUnsealed, incidents, rightsRequests } };
  }

  // ── Data-principal rights requests (DPDP) ──────────────────────────────────
  @Get('rights-requests')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'List DPDP data-principal rights requests with their SLA clocks' })
  async listRights() {
    return { success: true, data: await this.rights.list() };
  }

  @Get('rights-requests/:id')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'One rights request with its SLA clock' })
  async getRights(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.rights.get(id) };
  }

  @Post('rights-requests')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Log a data-principal rights request (starts the SLA clock)' })
  async createRights(@Body() dto: CreateRightsRequestDto, @Req() req: any) {
    return { success: true, data: await this.rights.create(dto, req.user?.id ?? null) };
  }

  @Patch('rights-requests/:id')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Update a rights request or record its resolution' })
  async updateRights(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRightsRequestDto, @Req() req: any) {
    return { success: true, data: await this.rights.update(id, dto, req.user?.id ?? null) };
  }

  @Get('incidents')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'List security incidents with their statutory clocks' })
  async list() {
    return { success: true, data: await this.incidents.list() };
  }

  @Get('incidents/:id')
  @Roles(SystemRole.ADMIN, SystemRole.AUDITOR)
  @ApiOperation({ summary: 'One security incident with its clocks' })
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.incidents.get(id) };
  }

  @Post('incidents')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Raise a security incident (starts the CERT-In / DPDP clocks)' })
  async create(@Body() dto: CreateIncidentDto, @Req() req: any) {
    return { success: true, data: await this.incidents.create(dto, req.user?.id ?? null) };
  }

  @Patch('incidents/:id')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Update an incident or record a reporting milestone' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIncidentDto, @Req() req: any) {
    return { success: true, data: await this.incidents.update(id, dto, req.user?.id ?? null) };
  }
}
