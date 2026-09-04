import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SystemRole } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, AnyAuthenticated } from './guards';
import { SessionService } from './session.service';

/** The roles at the resolved principal, as names, however roles were serialised onto req.user. */
function roleNames(user: any): string[] {
  return Array.isArray(user?.roles)
    ? user.roles.map((r: any) => (typeof r === 'string' ? r : r?.name)).filter(Boolean)
    : [];
}

/**
 * Sessions & devices — the "where am I signed in, and sign that device out" surface.
 *
 * Two audiences. Every signed-in person can see and revoke THEIR OWN sessions (the self-service
 * devices screen). An administrator can additionally list and revoke anyone's — the oversight and
 * incident-response tool a bank/RBI audit expects ("a compromised device was signed out at HH:MM").
 * Revoking a session revokes exactly its tokens; the audit trail records who did it and why.
 */
@ApiTags('Sessions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('sessions')
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  /** The caller's own sessions, with the current one flagged. Open to every signed-in principal. */
  @Get('me')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'List my own sessions / devices' })
  async mine(@Req() req: any) {
    const data = await this.sessions.listForUser(req.user.id, req.user.sid);
    return { success: true, data };
  }

  /** Any user's sessions — administrators only (login history / incident response). */
  @Get()
  @Roles(SystemRole.ADMIN)
  @ApiOperation({ summary: "List a user's sessions / login history (admin)" })
  async forUser(@Query('userId') userId: string) {
    if (!userId) throw new BadRequestException('userId is required.');
    const data = await this.sessions.listForUser(userId);
    return { success: true, data };
  }

  /**
   * "Log out all my devices" — the control for a lost or stolen laptop that still holds a live
   * session. Revokes every session on the caller's own account; because the per-request session
   * gate refuses a revoked session on its very NEXT request, every device is signed out at once,
   * not after the access token expires. Reachable by any signed-in principal for their own account.
   */
  @Post('me/revoke-all')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out ALL my devices (revoke every session on my account)' })
  async revokeAllMine(@Req() req: any) {
    await this.sessions.revokeAllForUser(req.user.id, req.user.id, 'USER_REVOKED_ALL');
    return { success: true, data: { message: 'All your devices have been signed out.' } };
  }

  /**
   * Revoke one session. A person may revoke their own; an administrator may revoke anyone's.
   * The revoked device is refused on its very next request (the per-request session gate), not
   * only once its access token expires.
   */
  @Delete(':id')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Revoke a session / sign out a device' })
  async revoke(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const session = await this.sessions.findById(id);
    if (!session) throw new NotFoundException('Session not found.');

    const isSelf = session.userId === req.user.id;
    const isAdmin = roleNames(req.user).includes(SystemRole.ADMIN);
    if (!isSelf && !isAdmin) {
      throw new ForbiddenException('You can only revoke your own sessions.');
    }

    await this.sessions.revoke(id, req.user.id, isSelf ? 'USER_REVOKED' : 'ADMIN_REVOKED');
    return { success: true };
  }
}
