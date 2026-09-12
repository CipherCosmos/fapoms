import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole, InterviewOutcome } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { AssayerInterviewService } from './assayer-interview.service';

class RecordInterviewRequestDto {
  @IsString() @MinLength(1) @MaxLength(200)
  candidateName: string;

  @IsString() @MinLength(1) @MaxLength(20)
  mobile: string;

  @IsOptional() @IsEmail()
  email?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  @IsEnum(InterviewOutcome)
  outcome: InterviewOutcome;
}

/**
 * The Appraiser Recruitment spec's Module 1 — an internal-only interview gate that decides who
 * gets a self-registration invite. See `AssayerInterviewService` for the pass → invite hand-off.
 */
@ApiTags('Assayer interviews')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayer-interviews')
export class AssayerInterviewController {
  constructor(private readonly interviews: AssayerInterviewService) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:create:organization')
  @ApiOperation({ summary: 'Record an interview outcome; a PASS sends the candidate a registration link' })
  async record(@Body() dto: RecordInterviewRequestDto, @Req() req: any) {
    const interview = await this.interviews.record(
      dto,
      req.user.id,
      req.user.displayName ?? req.user.username ?? req.user.email ?? undefined,
      req.user.organizationId,
    );
    return { success: true, data: interview };
  }

  @Get()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'The interview log' })
  async list() {
    return { success: true, data: await this.interviews.list() };
  }
}
