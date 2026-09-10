import { Controller, Get, Post, Delete, Body, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsString, IsNumber, IsOptional, IsNotEmpty } from 'class-validator';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AnyAuthenticated, RoleOnly, AllowPermissionFallback } from '../../auth/guards';
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
// `PermissionsGuard` belongs in this chain, and its absence was the gap. `RolesGuard` consults
// `@RequirePermissions` only in the fallback branch it runs for roles `@Roles` did not match by
// name, so `configuration:view:platform` on `catalogue()` and `history()` was enforced against a
// role built in Admin -> Roles and never against ADMIN itself. The `@AllowPermissionFallback()`
// pairing on those two routes only means anything with this guard present.
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
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
  @AllowPermissionFallback()
  @RequirePermissions('configuration:view:platform')
  @ApiOperation({ summary: 'The rules that can be suspended, and what each one protects' })
  catalogue() {
    return { success: true, data: { rules: BYPASSABLE_RULES, defaultHours: DEFAULT_BYPASS_HOURS } };
  }

  /**
   * Open a bypass window. Administrators only.
   *
   * Not gated on a permission string but on the role itself: permissions are configurable, and
   * a capability that suspends the platform's controls should not be grantable by editing a
   * role in a screen. Someone who can do this can already do anything.
   *
   * `@RequirePermissions` stays below for `PermissionsGuard` (ADMIN already holds the grant, so
   * it is a no-op check there) and for the Swagger-visible contract, but `@RoleOnly()` is the
   * decorator that actually keeps the promise this comment makes: without it, `RolesGuard`'s own
   * custom-role fallback treats the line above identically to any other route pairing `@Roles`
   * with `@RequirePermissions` — which is exactly the general mechanism that lets a role built in
   * Admin -> Roles reach a page it was never named on. Confirmed live: a role holding nothing but
   * `configuration:edit:platform` (the same permission Platform Settings edits use) opened a real
   * bypass window with a 201, no ADMIN role anywhere on the account. `@RoleOnly()` removes the
   * fallback branch for this route only, so ADMIN (matched by name, unaffected) still passes and
   * every other role — built-in or custom — is refused before `PermissionsGuard` is ever asked.
   */
  @Post()
  @Roles(SystemRole.ADMIN)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
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

  /** Close the window early. Same reasoning and the same `@RoleOnly()` fix as `enable()` above. */
  @Delete()
  @Roles(SystemRole.ADMIN)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
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
  @AllowPermissionFallback()
  @RequirePermissions('configuration:view:platform')
  @ApiOperation({ summary: 'Past bypass windows, newest first' })
  async history(@Query('limit') limit = 50) {
    return { success: true, data: await this.ruleBypass.history(Number(limit) || 50) };
  }
}
