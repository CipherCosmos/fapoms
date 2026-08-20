import { Controller, Get, Post, Delete, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsString, IsNumber, IsOptional, IsNotEmpty } from 'class-validator';
import { JwtAuthGuard, RolesGuard, Roles, AnyAuthenticated } from '../../auth/guards';
import { SystemRole, BypassableRule, BYPASSABLE_RULES, DEFAULT_BYPASS_HOURS } from '@fapoms/shared';
import { RuleBypassService } from './rule-bypass.service';

export class EnableBypassDto {
  @IsArray()
  @IsString({ each: true })
  rules: BypassableRule[];

  @IsString()
  @IsNotEmpty()
  reason: string;

  @IsOptional()
  @IsNumber()
  hours?: number;
}

@ApiTags('Rule Bypass')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/rule-bypass')
export class RuleBypassController {
  constructor(private readonly ruleBypass: RuleBypassService) {}

  /**
   * The current state — readable by anyone signed in, deliberately.
   *
   * The banner that warns "the geofence is off right now" is worthless if only administrators
   * can see it. The operator planning an audit, and the assayer checking in from their sofa,
   * are exactly the people who need to know the record they are about to create is a test one.
   * Nothing here is sensitive: it names rules that are off, not how to defeat them.
   */
  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Which operational rules are currently suspended, if any' })
  async state() {
    return { success: true, data: await this.ruleBypass.getState() };
  }

  /** The catalogue, so the admin screen renders what each rule protects rather than a raw key. */
  @Get('catalogue')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'The rules that can be suspended, and what each one protects' })
  async catalogue() {
    return { success: true, data: { rules: BYPASSABLE_RULES, defaultHours: DEFAULT_BYPASS_HOURS } };
  }

  /**
   * Open a bypass window. Administrators only.
   *
   * Not gated on a permission string but on the role itself: permissions are configurable, and
   * a capability that suspends the platform's controls should not be grantable by editing a
   * role in a screen. Someone who can do this can already do anything.
   */
  @Post()
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Suspend named operational rules for a bounded window' })
  async enable(@Body() dto: EnableBypassDto, @Req() req: any) {
    const state = await this.ruleBypass.enable(
      dto.rules,
      dto.reason,
      dto.hours ?? DEFAULT_BYPASS_HOURS,
      { id: req.user.id, name: req.user.fullName ?? req.user.username ?? req.user.email ?? null },
    );
    return { success: true, data: state };
  }

  @Delete()
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Turn the current bypass window off before it expires' })
  async disable(@Req() req: any) {
    const state = await this.ruleBypass.disable({
      id: req.user.id,
      name: req.user.fullName ?? req.user.username ?? req.user.email ?? null,
    });
    return { success: true, data: state };
  }

  /** Every window ever opened, with what it was used for. */
  @Get('history')
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: 'Past bypass windows, newest first' })
  async history(@Query('limit') limit = 50) {
    return { success: true, data: await this.ruleBypass.history(Number(limit) || 50) };
  }
}
