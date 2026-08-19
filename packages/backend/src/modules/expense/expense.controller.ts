/**
 * FAPOMS — Expense Controller
 *
 * The route shapes here are dictated by the mobile client, which has been calling
 * `POST /assignments/:assignmentId/expenses` against nothing at all. Keeping that exact path
 * means existing installs start working without an app update.
 */

import {
  Controller, Get, Post, Body, Param, Query, Req, UseGuards, ParseUUIDPipe, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsEnum, IsBoolean, Min } from 'class-validator';

import { ExpenseService } from './expense.service';
import { ExpenseCategory, ExpenseStatus } from './expense.entity';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';

class CreateExpenseRequestDto {
  @IsEnum(ExpenseCategory)
  category: ExpenseCategory;

  @IsNumber() @Min(0.01)
  amount: number;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString()
  receiptUrl?: string;
}

class ReviewExpenseRequestDto {
  @IsBoolean()
  approve: boolean;

  @IsOptional() @IsString()
  notes?: string;
}

/** True when this principal is a field assayer rather than internal staff. */
function assayerIdOf(user: any): string | null {
  const roles: string[] = (user?.roles ?? [])
    .map((r: any) => (typeof r === 'string' ? r : r?.name))
    .filter(Boolean);
  return roles.includes(SystemRole.ASSAYER) ? user?.id ?? null : null;
}

@ApiTags('Expenses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller()
export class ExpenseController {
  constructor(private readonly expenseService: ExpenseService) {}

  @Post('assignments/:assignmentId/expenses')
  @Roles(SystemRole.ASSAYER, ...STAFF_ROLES)
  @ApiOperation({ summary: 'Raise a reimbursement claim against an assignment' })
  async create(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: CreateExpenseRequestDto,
    @Req() req: any,
  ) {
    // An assayer may only claim on their own assignment; the service enforces it when this
    // resolves to an id, and staff raising a claim on someone's behalf skip the check.
    const claimant = assayerIdOf(req.user);
    return {
      success: true,
      data: await this.expenseService.create(assignmentId, dto, req.user.userId ?? req.user.id, claimant),
    };
  }

  @Get('assignments/:assignmentId/expenses')
  @Roles(SystemRole.ASSAYER, ...STAFF_ROLES)
  @ApiOperation({ summary: 'List claims against one assignment' })
  async findForAssignment(
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Req() req: any,
  ) {
    const expenses = await this.expenseService.findForAssignment(assignmentId);
    const claimant = assayerIdOf(req.user);
    if (claimant && expenses.some((e) => e.assayerId !== claimant)) {
      throw new ForbiddenException('You can only view claims on your own assignments.');
    }
    return { success: true, data: expenses };
  }

  @Get('expenses/mine')
  @Roles(SystemRole.ASSAYER)
  @ApiOperation({ summary: "The signed-in assayer's own claims" })
  async findMine(@Req() req: any, @Query('status') status?: ExpenseStatus) {
    return { success: true, data: await this.expenseService.findForAssayer(req.user.id, status) };
  }

  @Get('expenses/mine/summary')
  @Roles(SystemRole.ASSAYER)
  @ApiOperation({ summary: 'Claim totals for the mobile earnings screen' })
  async mySummary(@Req() req: any) {
    return { success: true, data: await this.expenseService.summaryForAssayer(req.user.id) };
  }

  @Get('expenses/pending')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE, SystemRole.FINANCE_MANAGER,
  )
  @ApiOperation({ summary: 'Claims awaiting a decision' })
  async findPending() {
    return { success: true, data: await this.expenseService.findPending() };
  }

  @Get('assayers/:assayerId/expenses')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE,
    SystemRole.FINANCE_MANAGER, SystemRole.HR_MANAGER, SystemRole.READ_ONLY_AUDITOR,
  )
  @ApiOperation({ summary: "One assayer's claim history" })
  async findForAssayer(
    @Param('assayerId', ParseUUIDPipe) assayerId: string,
    @Query('status') status?: ExpenseStatus,
  ) {
    return { success: true, data: await this.expenseService.findForAssayer(assayerId, status) };
  }

  // Approving reimbursement commits money, so this is narrower than the read routes above.
  @Post('expenses/:expenseId/review')
  @Roles(
    SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR,
    SystemRole.OPERATIONS_MANAGER, SystemRole.FINANCE_MANAGER,
  )
  @ApiOperation({ summary: 'Approve or reject a claim' })
  async review(
    @Param('expenseId', ParseUUIDPipe) expenseId: string,
    @Body() dto: ReviewExpenseRequestDto,
    @Req() req: any,
  ) {
    return {
      success: true,
      data: await this.expenseService.review(expenseId, dto.approve, req.user.userId ?? req.user.id, dto.notes),
    };
  }
}
