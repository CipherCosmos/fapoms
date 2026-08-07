import { Controller, Get, Post, Patch, Query, Param, Body, UseGuards, Req, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BillingEngineService, CreateEntryDto, SplitEntryDto } from './billing-engine.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import {
  SystemRole,
  BillingLevel,
  BillingState,
  InvoiceStatus,
  InvoiceType,
  PaymentMethod,
  AssayerPayableStatus,
  BillingConflictSeverity,
  BillingConflictStatus,
  BillingEntityType,
} from '@fapoms/shared';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsEnum, IsArray, IsUUID, IsObject, Min } from 'class-validator';

// ---- DTOs ---------------------------------------------------------------

class CreateEntryRequestDto implements CreateEntryDto {
  @IsEnum(BillingLevel) level: BillingLevel;
  @IsUUID() clientId: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsOptional() @IsUUID() assayerId?: string;
  @IsOptional() @IsString() pricingModel?: any;
  @IsOptional() @IsNumber() @Min(0) rate?: number;
  @IsOptional() @IsNumber() @Min(0) quantity?: number;
  @IsOptional() @IsString() billingPeriodStart?: string;
  @IsOptional() @IsString() billingPeriodEnd?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Min(0) baseAmount?: number;
  @IsOptional() @IsNumber() @Min(0) travelAmount?: number;
  @IsOptional() @IsNumber() adjustmentAmount?: number;
  @IsOptional() @IsNumber() @Min(0) discountAmount?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsNumber() @Min(0) tdsRate?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsEnum(BillingState) initialState?: BillingState;
}

class TransitionEntryDto {
  @IsEnum(BillingState) status: BillingState;
  @IsOptional() @IsString() reason?: string;
}

class BulkTransitionEntriesDto {
  @IsArray() @IsNotEmpty()
  @IsUUID('4', { each: true })
  entryIds: string[];

  @IsEnum(BillingState) status: BillingState;
  @IsOptional() @IsString() reason?: string;
}

class AdjustEntryDto {
  @IsNumber() delta: number;
  @IsString() @IsNotEmpty() reason: string;
}

class SplitEntryRequestDto implements SplitEntryDto {
  @IsArray() @IsNumber({}, { each: true }) amounts: number[];
  @IsOptional() @IsString() notes?: string;
}

class MergeEntriesDto {
  @IsArray() @IsUUID('4', { each: true }) entryIds: string[];
  @IsOptional() @IsString() note?: string;
}

class CreateInvoiceDto {
  @IsUUID() clientId: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsEnum(InvoiceType) type: InvoiceType;
  @IsArray() @IsUUID('4', { each: true }) entryIds: string[];
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() notes?: string;
}

class TransitionInvoiceDto {
  @IsEnum(InvoiceStatus) status: InvoiceStatus;
  @IsOptional() @IsString() reason?: string;
}

class RecordPaymentDto {
  @IsUUID() invoiceId: string;
  @IsString() @IsNotEmpty() paymentReference: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() receivedDate?: string;
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) allocatedToEntryIds?: string[];
  @IsOptional() @IsString() notes?: string;
}

class CreatePayableDto {
  @IsUUID() assayerId: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsNumber() @Min(0) baseAmount: number;
  @IsOptional() @IsNumber() @Min(0) travelAmount?: number;
  @IsOptional() @IsNumber() @Min(0) taxRate?: number;
  @IsOptional() @IsNumber() @Min(0) tdsRate?: number;
  @IsOptional() @IsObject() rateSnapshot?: Record<string, unknown>;
  @IsOptional() @IsString() remarks?: string;
}

class TransitionPayableDto {
  @IsEnum(AssayerPayableStatus) status: AssayerPayableStatus;
  @IsOptional() @IsString() reason?: string;
}

class DisbursePayableDto {
  @IsString() @IsNotEmpty() paymentReference: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  /** Omit to settle the full outstanding balance on the payable. */
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsString() paidDate?: string;
  @IsOptional() @IsString() notes?: string;
}

class RaiseConflictDto {
  @IsEnum(BillingConflictSeverity) severity: BillingConflictSeverity;
  @IsEnum(BillingEntityType) entityType: BillingEntityType;
  @IsArray() @IsUUID('4', { each: true }) entryIds: string[];
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() blocksBilling?: boolean;
}

class ResolveConflictDto {
  @IsEnum(BillingConflictStatus) status: BillingConflictStatus;
  @IsString() action: string;
  @IsString() @IsNotEmpty() note: string;
}

// ---- Controller ---------------------------------------------------------

/**
 * Finance owns the money. OPERATIONS_MANAGER is retained because operations
 * raised billing lines before a finance role existed, but disbursing money is
 * deliberately narrower — see DISBURSEMENT_ROLES.
 */
const BILLING_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.FINANCE_MANAGER,
  SystemRole.OPERATIONS_MANAGER,
];

/** Paying money out is restricted to finance and administrators. */
const DISBURSEMENT_ROLES = [
  SystemRole.SUPER_ADMINISTRATOR,
  SystemRole.ADMINISTRATOR,
  SystemRole.FINANCE_MANAGER,
];

@ApiTags('Billing Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('billing-engine')
export class BillingEngineController {
  constructor(private readonly service: BillingEngineService) {}

  // Sync
  @Post('sync/assignments')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Ingest real billable assignments into billing entries' })
  async syncAssignments(@Req() req: any) {
    return this.service.syncFromAssignments(req.user?.id ?? req.user?.userId ?? 'system');
  }

  // Entries
  @Post('entries')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Create a billing entry (client/project/assignment)' })
  async createEntry(@Body() dto: CreateEntryRequestDto, @Req() req: any) {
    const entry = await this.service.createEntry(dto, req.user.id);
    return { success: true, data: entry };
  }

  @Get('entries')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'List billing entries with filters, including client/project/assignment names' })
  async findEntries(
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('assignmentId') assignmentId?: string,
    @Query('assayerId') assayerId?: string,
    @Query('level') level?: BillingLevel,
    @Query('state') state?: BillingState,
  ) {
    const entries = await this.service.findEntriesEnriched({ clientId, projectId, assignmentId, assayerId, level, state });
    return { success: true, data: entries };
  }

  @Get('entries/:id')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get a billing entry' })
  async getEntry(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.service.getEntry(id) };
  }

  @Patch('entries/state')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Transition a batch of billing entries to a target state' })
  async bulkTransitionEntries(@Body() dto: BulkTransitionEntriesDto, @Req() req: any) {
    return { success: true, data: await this.service.bulkTransitionEntries(dto.entryIds, dto.status, req.user.id, dto.reason) };
  }

  @Patch('entries/:id/state')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Transition a billing entry state' })
  async transitionEntry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionEntryDto, @Req() req: any) {
    return { success: true, data: await this.service.transitionEntry(id, dto.status, req.user.id, dto.reason) };
  }

  @Patch('entries/:id/adjust')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Apply an adjustment to a billing entry' })
  async adjustEntry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AdjustEntryDto, @Req() req: any) {
    return { success: true, data: await this.service.adjustEntry(id, dto.delta, dto.reason, req.user.id) };
  }

  @Post('entries/:id/split')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Split a billing entry into multiple parts' })
  async splitEntry(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SplitEntryRequestDto, @Req() req: any) {
    return { success: true, data: await this.service.splitEntry(id, dto, req.user.id) };
  }

  @Post('entries/merge')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Merge multiple billing entries into one' })
  async mergeEntries(@Body() dto: MergeEntriesDto, @Req() req: any) {
    return { success: true, data: await this.service.mergeEntries(dto.entryIds, req.user.id, dto.note) };
  }

  // Invoices
  @Post('invoices')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Create an invoice from approved entries' })
  async createInvoice(@Body() dto: CreateInvoiceDto, @Req() req: any) {
    return { success: true, data: await this.service.createInvoice(dto, req.user.id) };
  }

  @Get('invoices')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'List invoices' })
  async findInvoices(@Query('clientId') clientId?: string, @Query('projectId') projectId?: string, @Query('status') status?: InvoiceStatus) {
    return { success: true, data: await this.service.findInvoices({ clientId, projectId, status }) };
  }

  @Get('invoices/:id')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Get an invoice with entries and payments' })
  async getInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.service.getInvoice(id) };
  }

  @Patch('invoices/:id/status')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Transition an invoice status' })
  async transitionInvoice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionInvoiceDto, @Req() req: any) {
    return { success: true, data: await this.service.transitionInvoice(id, dto.status, req.user.id, dto.reason) };
  }

  // Payments
  @Post('payments')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Record a payment against an invoice' })
  async recordPayment(@Body() dto: RecordPaymentDto, @Req() req: any) {
    return { success: true, data: await this.service.recordPayment(dto, req.user.id) };
  }

  // Assayer payables
  @Post('payables')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Create an assayer payable (separate from client billing)' })
  async createPayable(@Body() dto: CreatePayableDto, @Req() req: any) {
    return { success: true, data: await this.service.createPayable(dto, req.user.id) };
  }

  @Get('payables')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'List assayer payables with assayer/project names' })
  async findPayables(@Query('assayerId') assayerId?: string, @Query('clientId') clientId?: string, @Query('status') status?: AssayerPayableStatus) {
    return { success: true, data: await this.service.findPayablesEnriched({ assayerId, clientId, status }) };
  }

  @Patch('payables/:id/status')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Transition an assayer payable status' })
  async transitionPayable(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransitionPayableDto, @Req() req: any) {
    return { success: true, data: await this.service.transitionPayable(id, dto.status, req.user.id, dto.reason) };
  }

  @Post('payables/:id/disburse')
  @Roles(...DISBURSEMENT_ROLES)
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Disburse money against an approved assayer payable' })
  async disburse(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DisbursePayableDto, @Req() req: any) {
    return {
      success: true,
      data: await this.service.recordDisbursement({ ...dto, payableId: id }, req.user.id),
    };
  }

  @Get('assayers/:assayerId/statement')
  @Roles(...BILLING_ROLES, SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Assayer financial statement: earned, paid, outstanding and history' })
  async assayerStatement(@Param('assayerId', ParseUUIDPipe) assayerId: string) {
    return { success: true, data: await this.service.assayerStatement(assayerId) };
  }

  // Conflicts
  @Post('conflicts')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Raise a billing conflict' })
  async raiseConflict(@Body() dto: RaiseConflictDto, @Req() req: any) {
    return { success: true, data: await this.service.raiseConflict(dto, req.user.id) };
  }

  @Get('conflicts')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'List conflicts' })
  async findConflicts(@Query('status') status?: BillingConflictStatus) {
    return { success: true, data: await this.service.findConflicts(status) };
  }

  @Patch('conflicts/:id/resolve')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Resolve a billing conflict' })
  async resolveConflict(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveConflictDto, @Req() req: any) {
    return { success: true, data: await this.service.resolveConflict(id, dto, req.user.id) };
  }

  // History
  @Get('history')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Billing history / audit trail' })
  async getHistory(
    @Query('clientId') clientId?: string,
    @Query('projectId') projectId?: string,
    @Query('assignmentId') assignmentId?: string,
    @Query('assayerId') assayerId?: string,
    @Query('entityType') entityType?: BillingEntityType,
  ) {
    return { success: true, data: await this.service.getHistory({ clientId, projectId, assignmentId, assayerId, entityType }) };
  }

  // Dashboard & reports
  @Get('dashboard')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Billing dashboard summary (optionally per client)' })
  async dashboard(@Query('clientId') clientId?: string) {
    return { success: true, data: await this.service.dashboard(clientId) };
  }

  @Get('ledger/:entityType/:entityId')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Complete financial record for any client, project, branch, assayer or assignment' })
  async entityLedger(
    @Param('entityType') entityType: 'client' | 'project' | 'branch' | 'assayer' | 'assignment',
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ) {
    return { success: true, data: await this.service.entityLedger(entityType, entityId) };
  }

  @Get('finance/dashboard')
  @Roles(...BILLING_ROLES)
  @ApiOperation({ summary: 'Finance console: receivables, payables, cash-flow, margin and tax position' })
  async financeDashboard() {
    return { success: true, data: await this.service.financeDashboard() };
  }

  @Get('clients')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Clients with billing activity, for scoping the billing workspace' })
  async clientsWithBilling() {
    return { success: true, data: await this.service.clientsWithBilling() };
  }

  @Get('reports/client/:clientId')
  @Roles(...BILLING_ROLES, SystemRole.READ_ONLY_AUDITOR)
  @ApiOperation({ summary: 'Client → projects → assignments billing report with margin and ageing' })
  async clientReport(@Param('clientId', ParseUUIDPipe) clientId: string) {
    return { success: true, data: await this.service.clientReport(clientId) };
  }
}
