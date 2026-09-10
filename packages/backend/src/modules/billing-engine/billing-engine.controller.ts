import {
  Controller, Get, Post, Patch, Query, Param, Body, UseGuards, Req, ParseUUIDPipe,
  ForbiddenException, BadRequestException, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsString, IsNotEmpty, IsOptional, IsNumber, IsEnum, IsArray, IsUUID, IsBoolean, IsBooleanString,
  ArrayNotEmpty, Min,
} from 'class-validator';
import { BillingEngineService } from './billing-engine.service';
import { AssayerInvoiceService } from './assayer-invoice.service';
import { BillingJobsService } from './billing-jobs.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { BILLING_ROLES, BILLING_READ_ROLES, DISBURSEMENT_ROLES } from './billing-roles';
import { SystemRole, BillingState, InvoiceStatus, PaymentMethod, AssayerPayableStatus, AssayerInvoiceStatus } from '@fapoms/shared';

// ---- DTOs ---------------------------------------------------------------

class PayoutIdsDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true })
  payableIds: string[];
}

class PayPayoutsDto extends PayoutIdsDto {
  @IsString() @IsNotEmpty() paymentReference: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsOptional() @IsString() paidDate?: string;
  @IsOptional() @IsString() notes?: string;
}

class HoldDto {
  @IsBoolean() onHold: boolean;
  @IsOptional() @IsString() reason?: string;
}

class ClientLineDto {
  @IsOptional() @IsNumber() adjustmentAmount?: number;
  @IsOptional() @IsString() adjustmentReason?: string;
  @IsOptional() @IsBoolean() onHold?: boolean;
  @IsOptional() @IsString() holdReason?: string;
}

class CreateInvoiceDto {
  @IsUUID() clientId: string;
  @IsArray() @ArrayNotEmpty() @IsUUID('4', { each: true }) assignmentIds: string[];
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() notes?: string;
}

class InvoicePaymentDto {
  @IsString() @IsNotEmpty() paymentReference: string;
  @IsEnum(PaymentMethod) method: PaymentMethod;
  @IsNumber() @Min(0.01) amount: number;
  @IsOptional() @IsString() receivedDate?: string;
  @IsOptional() @IsString() notes?: string;
}

class ReasonDto {
  @IsString() @IsNotEmpty() reason: string;
}

class ReconcileDto {
  /** Only assignments completed on or after this date (YYYY-MM-DD). Omit for the whole book. */
  @IsOptional() @IsString() since?: string;
}

/**
 * The list endpoints take their filters as one DTO rather than as loose `@Query('x')` params.
 *
 * A bare `@Query()` binds the WHOLE query string and validates it, and this app's global pipe
 * runs with `forbidNonWhitelisted` — so mixing a `@Query() page: PageQuery` with sibling
 * `@Query('status')` params made `?status=PENDING` a 400 ("property status should not exist"),
 * while `?page=2` alone worked. One DTO per endpoint, listing everything it accepts.
 */
class PayoutsQuery {
  @IsOptional() @IsUUID() assayerId?: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsEnum(AssayerPayableStatus) status?: AssayerPayableStatus;
  /** `?onHold=true` narrows to held payouts; omit for both. */
  @IsOptional() @IsBooleanString() onHold?: string;
  @IsOptional() @Type(() => Number) @IsNumber() page?: number;
  @IsOptional() @Type(() => Number) @IsNumber() limit?: number;
}

class InvoicesQuery {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsEnum(InvoiceStatus) status?: InvoiceStatus;
  @IsOptional() @Type(() => Number) @IsNumber() page?: number;
  @IsOptional() @Type(() => Number) @IsNumber() limit?: number;
}

class LinesQuery {
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsOptional() @IsUUID() assayerId?: string;
  @IsOptional() @IsEnum(BillingState) state?: BillingState;
  @IsOptional() @Type(() => Number) @IsNumber() page?: number;
  @IsOptional() @Type(() => Number) @IsNumber() limit?: number;
}

class InvoiceableQuery {
  @IsOptional() @IsUUID() clientId?: string;
}

class ReconcilePreviewQuery {
  @IsOptional() @IsString() since?: string;
}

class TdsReportQuery {
  /** Inclusive booking-date window (YYYY-MM-DD). Omit both for the whole book. */
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

/** `{assayerId}` invites one assayer; `{all: true}` runs the bulk cadence round. */
class InviteAssayerInvoiceDto {
  @IsOptional() @IsUUID() assayerId?: string;
  @IsOptional() @IsBoolean() all?: boolean;
}

class AssayerInvoicesQuery {
  @IsOptional() @IsEnum(AssayerInvoiceStatus) status?: AssayerInvoiceStatus;
  @IsOptional() @IsUUID() assayerId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() page?: number;
  @IsOptional() @Type(() => Number) @IsNumber() limit?: number;
}

class SubmitInvoiceInvitationDto {
  /**
   * The submission's idempotency key, minted by the client — a retried POST with the same id
   * returns the original submission instead of conflicting (see `submittedRequestId`).
   */
  @IsUUID() clientRequestId: string;
}

// ---- Controller ---------------------------------------------------------

/**
 * The billing API: the assignment is the ledger line.
 *
 * Reads for everyone who may see the book; invoicing (client- and assayer-side) for billing
 * staff; approving, paying and holding payouts for finance and administrators only — money
 * leaving the business has one gate. The two `invoice-invitation` routes are the sole
 * assayer-facing writes: an assayer reviews and submits their OWN invitation, nothing else.
 */
@ApiTags('Billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('billing-engine')
export class BillingEngineController {
  constructor(
    private readonly service: BillingEngineService,
    private readonly assayerInvoices: AssayerInvoiceService,
    private readonly jobs: BillingJobsService,
    private readonly regionGuard: RegionGuardService,
  ) {}

  private userId(req: any): string {
    return req.user?.id ?? req.user?.userId ?? 'system';
  }

  // ── Overview ──────────────────────────────────────────────────────────────

  /**
   * `@GlobalScopeFilter()` was the one thing every other billing read on this controller had and
   * this route did not, so a region-assigned account read the whole organisation's book from the
   * screen that heads the tabs it could not read from. The decorator resolves the ceiling from
   * `users.regions` before the handler runs, so `?region=` can only ever narrow: naming a region
   * the account does not hold is a 403, and `?organizationId=` / `?scope=` are not parameters
   * this system has and are ignored.
   */
  @Get('overview')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'The finance overview: payouts, receivables, margin, tax, cash, attention, by client' })
  async overview(@GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.overview(scope) };
  }

  // ── Payouts ───────────────────────────────────────────────────────────────

  @Get('payouts')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Assayer payouts (fee and reimbursement payables) with labels, paged' })
  async payouts(@Query() q: PayoutsQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return {
      success: true,
      data: await this.service.listPayouts({
        assayerId: q.assayerId,
        clientId: q.clientId,
        status: q.status,
        onHold: q.onHold === undefined ? undefined : q.onHold === 'true',
        page: q.page,
        limit: q.limit,
      }, scope),
    };
  }

  @Post('payouts/approve')
  @Roles(...DISBURSEMENT_ROLES)
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Approve payouts (the one gate before payment)' })
  async approvePayouts(@Body() dto: PayoutIdsDto, @Req() req: any) {
    return { success: true, data: await this.service.approvePayouts(dto.payableIds, this.userId(req)) };
  }

  @Post('payouts/pay')
  @Roles(...DISBURSEMENT_ROLES)
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Pay approved payouts in full, each as a recorded disbursement' })
  async payPayouts(@Body() dto: PayPayoutsDto, @Req() req: any) {
    const { payableIds, ...payment } = dto;
    return { success: true, data: await this.service.payPayouts(payableIds, payment, this.userId(req)) };
  }

  @Post('payouts/bank-file')
  @Roles(...DISBURSEMENT_ROLES)
  @RequirePermissions('billing:approve:organization')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Bank details (beneficiary, account, IFSC, net amount) for the selected approved-unpaid payouts, for the NEFT bank file' })
  async payoutBankFile(@Body() dto: PayoutIdsDto, @Req() req: any) {
    return { success: true, data: await this.service.payoutBankDetails(dto.payableIds, this.userId(req)) };
  }

  @Get('tds-report')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'PAN-wise TDS withheld from assayers over a period, for TDS substantiation' })
  async tdsReport(@Query() q: TdsReportQuery) {
    return { success: true, data: await this.service.tdsReport({ from: q.from || null, to: q.to || null }) };
  }

  @Patch('payouts/:id/hold')
  @Roles(...DISBURSEMENT_ROLES)
  // A hold is the brake on the payment run, not an edit to a payout's figures: releasing one
  // sends money that was stopped. It sits with approve/pay/bank-file, not with `billing:edit`.
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Put a payout on hold, or release it' })
  async holdPayout(@Param('id', ParseUUIDPipe) id: string, @Body() dto: HoldDto, @Req() req: any) {
    return { success: true, data: await this.service.holdPayout(id, dto.onHold, dto.reason, this.userId(req)) };
  }

  @Get('assayers/:assayerId/statement')
  /**
   * `BILLING_READ_ROLES`, like every other read on this controller — this was the one that
   * still said `BILLING_ROLES`, and so the one that left the auditor out.
   *
   * The cost, reproduced in a browser: an AUDITOR opens `/billing`, follows the ungated
   * "Assayer statements →" link, gets a picker filled with the whole roster (`GET /assayers`
   * answers 200 for them), chooses somebody — and the page renders **nothing at all**. No error,
   * no empty state. A blank money screen for an auditor is not a broken page; it reads as
   * "this person has never been paid anything."
   *
   * `billing-roles.ts` already decided this exact question for the export route: "the auditor
   * could read every billing figure on screen and got a 403 the moment they pressed Export, on a
   * button the page rendered for them unconditionally. Auditing is a reading job, and an export
   * is a read." A statement is a read too.
   */
  @Roles(...BILLING_READ_ROLES, SystemRole.ASSAYER)
  // Deliberately no @RequirePermissions: an assayer authenticates from the `assayers` table and
  // holds no permission rows at all, so any declaration here would be checked against an empty
  // set and lock the field app out of its own earnings screen. Custom roles reach this route by
  // name only, until an assayer principal can hold a grant.
  @ApiOperation({ summary: 'Assayer financial statement: earned, paid, outstanding and history' })
  async assayerStatement(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    // An assayer may read only their own statement; the path id is attacker-controlled.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    /**
     * Read against the same list the gate uses, not the narrower one.
     *
     * Widening only the decorator would have admitted the auditor and then refused them here with
     * "You may only view your own statement" — a worse answer than the 403 it replaced, because
     * it accuses. An auditor reads the full book by definition; that is what auditing is.
     */
    const isBillingStaff = roles.some((r) => (BILLING_READ_ROLES as string[]).includes(r));
    if (!isBillingStaff && req.user?.id !== assayerId) {
      throw new ForbiddenException('You may only view your own statement.');
    }
    // The audience fork is decided HERE, off the authenticated principal — never off anything
    // the client sends. Staff keep the full book; an assayer principal gets the earnings-gated
    // shape (only invoice-approved and grandfathered rows) once assayer invoicing is enabled.
    return {
      success: true,
      data: await this.service.assayerStatement(assayerId, scope, isBillingStaff ? 'staff' : 'assayer'),
    };
  }

  // ── Assayer invoices (the consent wrapper over payables) ─────────────────
  //
  // The rollout gate: the feature ships dark behind `billing.assayerInvoicingEnabled`, and
  // while the flag is off, `assertEnabled()` makes the gated routes answer 404 as if they did
  // not exist. Gated: the INVITE route (nothing may start a reveal while dark) and BOTH
  // assayer-facing invitation routes (the reveal itself, and submit). Deliberately NOT gated:
  // the ops reads (an empty list is harmless) and approve/cancel — if the flag is ever turned
  // OFF with invoices in flight, ops must still be able to land or cancel them; a gate there
  // would strand consented submissions behind the very switch meant to make rollout safe.

  @Post('assayer-invoices/invite')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:create:organization')
  @ApiOperation({ summary: 'Invite one assayer ({assayerId}) or every assayer with eligible work ({all: true}) to submit an invoice' })
  async inviteAssayerInvoices(@Body() dto: InviteAssayerInvoiceDto, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.assayerInvoices.assertEnabled();
    if (dto.all) {
      // No single-assayer scope assert here — the SERVICE filters the round to the caller's
      // regions (assayers.region IN …), so a region desk's "invite everyone" means everyone
      // they can see, and the per-assayer outcomes never name anyone outside their scope.
      return { success: true, data: await this.assayerInvoices.inviteAll(this.userId(req), scope) };
    }
    if (!dto.assayerId) {
      throw new BadRequestException('Pass an assayerId, or {all: true} for the bulk round.');
    }
    await this.regionGuard.assertAssayerInScope(dto.assayerId, scope);
    return { success: true, data: await this.assayerInvoices.invite(dto.assayerId, this.userId(req)) };
  }

  @Get('assayer-invoices')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Assayer invoices with labels, paged' })
  async listAssayerInvoices(@Query() q: AssayerInvoicesQuery) {
    return { success: true, data: await this.assayerInvoices.list(q) };
  }

  @Get('assayer-invoices/:id')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'One assayer invoice with its lines' })
  async assayerInvoice(@Param('id', ParseUUIDPipe) id: string) {
    return { success: true, data: await this.assayerInvoices.getById(id) };
  }

  @Post('assayer-invoices/:id/approve')
  @Roles(...DISBURSEMENT_ROLES)
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Approve a submitted assayer invoice — approves every line payable in the same transaction' })
  async approveAssayerInvoice(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.assayerInvoices.approve(id, this.userId(req)) };
  }

  @Patch('assayer-invoices/:id/cancel')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:edit:organization')
  @ApiOperation({ summary: 'Cancel an invited/submitted assayer invoice; its lines return to the eligible pool' })
  async cancelAssayerInvoice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return { success: true, data: await this.assayerInvoices.cancel(id, this.userId(req), dto.reason) };
  }

  @Get('assayers/:assayerId/invoice-invitation')
  @Roles(...BILLING_ROLES, SystemRole.ASSAYER)
  // Deliberately no @RequirePermissions, for the same reason as the statement route above: an
  // assayer principal holds no permission rows at all.
  @ApiOperation({ summary: 'The active invoice invitation for an assayer — THE money reveal — or null' })
  async assayerInvoiceInvitation(@Param('assayerId', ParseUUIDPipe) assayerId: string, @Req() req: any, @GlobalScopeFilter() scope?: GlobalScope) {
    await this.assayerInvoices.assertEnabled();
    // An assayer may read only their own invitation; the path id is attacker-controlled.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isBillingStaff = roles.some((r) => (BILLING_ROLES as string[]).includes(r));
    if (!isBillingStaff && req.user?.id !== assayerId) {
      throw new ForbiddenException('You may only view your own invoice invitation.');
    }
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return { success: true, data: await this.assayerInvoices.getInvitationFor(assayerId, scope) };
  }

  @Post('assayers/:assayerId/invoice-invitation/submit')
  @Roles(...BILLING_ROLES, SystemRole.ASSAYER)
  // Deliberately no @RequirePermissions — see the statement route.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Submit the active invitation (idempotent by clientRequestId) — the assayer’s consent to the shown figures' })
  async submitAssayerInvoiceInvitation(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Body() dto: SubmitInvoiceInvitationDto,
    @Req() req: any,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    await this.assayerInvoices.assertEnabled();
    // An assayer may submit only their own invitation; the path id is attacker-controlled.
    const roles: string[] = (req.user?.roles ?? []).map((r: any) => r?.name ?? r).filter(Boolean);
    const isBillingStaff = roles.some((r) => (BILLING_ROLES as string[]).includes(r));
    if (!isBillingStaff && req.user?.id !== assayerId) {
      throw new ForbiddenException('You may only submit your own invoice invitation.');
    }
    await this.regionGuard.assertAssayerInScope(assayerId, scope);
    return { success: true, data: await this.assayerInvoices.submit(assayerId, dto.clientRequestId) };
  }

  // ── Invoices ──────────────────────────────────────────────────────────────

  @Get('invoiceable')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Completed work not yet invoiced, grouped by client' })
  async invoiceable(@Query() q: InvoiceableQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.listInvoiceable({ clientId: q.clientId }, scope) };
  }

  @Post('invoices')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:create:organization')
  @ApiOperation({ summary: 'Invoice a set of completed assignments for one client' })
  async createInvoice(@Body() dto: CreateInvoiceDto, @Req() req: any) {
    return { success: true, data: await this.service.createInvoice(dto, this.userId(req)) };
  }

  @Get('invoices')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Invoices, paged' })
  async invoices(@Query() q: InvoicesQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.findInvoicesPage(q, scope) };
  }

  @Get('invoices/:id')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'One invoice with its lines and payments' })
  async invoice(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.getInvoice(id, scope) };
  }

  @Get('invoices/:id/document')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'The GST tax invoice document: both GSTINs, place of supply, CGST/SGST or IGST split, amount in words' })
  async invoiceDocument(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.getInvoiceDocument(id, scope) };
  }

  @Patch('invoices/:id/send')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:edit:organization')
  @ApiOperation({ summary: 'Mark an invoice as sent to the client' })
  async sendInvoice(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return { success: true, data: await this.service.sendInvoice(id, this.userId(req)) };
  }

  @Post('invoices/:id/payment')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:create:organization')
  @ApiOperation({ summary: 'Record money received against a sent invoice' })
  async recordPayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoicePaymentDto, @Req() req: any) {
    return { success: true, data: await this.service.recordPayment({ ...dto, invoiceId: id }, this.userId(req)) };
  }

  @Patch('invoices/:id/cancel')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:edit:organization')
  @ApiOperation({ summary: 'Cancel an unpaid invoice; its lines become invoiceable again' })
  async cancelInvoice(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return { success: true, data: await this.service.cancelInvoice(id, dto.reason, this.userId(req)) };
  }

  @Post('payments/:id/reverse')
  @Roles(...DISBURSEMENT_ROLES)
  // Reversal moves money back, in either direction. Held with the disbursement controls rather
  // than with `billing:edit`, which is where invoice corrections live.
  @RequirePermissions('billing:approve:organization')
  @ApiOperation({ summary: 'Reverse a recorded payment (either direction)' })
  async reversePayment(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: any) {
    return { success: true, data: await this.service.reversePayment(id, dto.reason, this.userId(req)) };
  }

  // ── The assignment's money ────────────────────────────────────────────────

  @Get('assignments/:id/money')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Everything money-related about one assignment' })
  async assignmentMoney(@Param('id', ParseUUIDPipe) id: string, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.assignmentMoneyLine(id, scope) };
  }

  @Patch('assignments/:id/client-line')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:edit:organization')
  @ApiOperation({ summary: 'Adjust or hold the client line for an assignment (before invoicing)' })
  async editClientLine(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ClientLineDto, @Req() req: any) {
    return { success: true, data: await this.service.editClientLine(id, dto, this.userId(req)) };
  }

  /**
   * Paged, like `payouts` and `invoices` beside it. This used to hand back every line matching
   * whatever filter was given — `?state=UNBILLED` with nothing else was a single request asking
   * for the entire, ever-growing `billing_entries` table. `listClientLines(..., true)` opts into
   * the same `billingPageWindow` clamp those two already use; the one caller that genuinely needs
   * an unbounded pull (the billing export in `reports.service.ts`, which self-caps separately)
   * calls the service directly and never sets `paginate`.
   */
  @Get('lines')
  @Roles(...BILLING_READ_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Client lines with labels, paged' })
  async lines(@Query() q: LinesQuery, @GlobalScopeFilter() scope?: GlobalScope) {
    return { success: true, data: await this.service.listClientLines(q, scope, true) };
  }

  // ── Reconcile (admin repair) ──────────────────────────────────────────────

  @Get('reconcile/preview')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'How many completed assignments a reconcile would book' })
  async reconcilePreview(@Query() q: ReconcilePreviewQuery) {
    return { success: true, data: await this.service.reconcilePreview({ since: q.since || null }) };
  }

  @Post('reconcile')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:create:organization')
  @ApiOperation({ summary: 'Queue a reconcile: book every completed assignment missing a payout or client line' })
  @HttpCode(HttpStatus.ACCEPTED)
  async reconcile(@Body() dto: ReconcileDto, @Req() req: any) {
    return { success: true, data: await this.jobs.enqueueReconcile(this.userId(req), dto.since || null) };
  }

  @Get('jobs/:jobId')
  @Roles(...BILLING_ROLES)
  @RequirePermissions('billing:view:organization')
  @ApiOperation({ summary: 'Poll a queued billing job' })
  async jobStatus(@Param('jobId') jobId: string, @Req() req: any) {
    return { success: true, data: await this.jobs.status(jobId, this.userId(req)) };
  }
}
