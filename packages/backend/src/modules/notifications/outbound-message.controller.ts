import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { OutboundMessageReceipt } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, AnyAuthenticated } from '../auth/guards';
import { rolesOf } from '../assayer/assayer-visibility';
import { OutboundMessageService } from './outbound-message.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a message (an email or a text) somebody's action queued has got to.
 *
 * Open to any signed-in person, because the ownership check is per row: you may read the messages
 * your own actions asked for, and an administrator may read any. Anything else answers 404.
 */
@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('outbound-messages')
export class OutboundMessageController {
  constructor(private readonly outbound: OutboundMessageService) {}

  private static viewer(req: any): { id: string; isAdmin: boolean } {
    const roles = rolesOf(req.user);
    return { id: req.user?.id, isAdmin: roles.includes('ADMIN') || roles.includes('DEVELOPER') };
  }

  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Where several queued messages have got to (ids=comma-separated)' })
  async many(@Query('ids') ids: string | undefined, @Req() req: any): Promise<OutboundMessageReceipt[]> {
    const list = (ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length > 500) throw new BadRequestException('Ask about at most 500 messages at a time.');
    if (list.some((id) => !UUID.test(id))) throw new BadRequestException('Every id must be a UUID.');
    return this.outbound.receiptsFor(list, OutboundMessageController.viewer(req));
  }

  @Get(':id')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Where one queued message has got to' })
  async one(@Param('id', ParseUUIDPipe) id: string, @Req() req: any): Promise<OutboundMessageReceipt> {
    return this.outbound.receiptFor(id, OutboundMessageController.viewer(req));
  }
}
