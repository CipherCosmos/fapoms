import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, AnyAuthenticated, OnboardingAllowed } from '../auth/guards';
import { IdCardService } from './id-card.service';

/** Only the person themselves: the live card is theirs to show, nobody else's to mint. */
function ownAssayerId(req: any): string {
  const roles: string[] = Array.isArray(req.user?.roles) ? req.user.roles : [req.user?.role].filter(Boolean);
  if (!roles.includes('ASSAYER') || !req.user?.id) {
    throw new ForbiddenException('The ID card is shown only in the assayer\'s own app.');
  }
  return req.user.id;
}

/**
 * THE DIGITAL ID CARD, in the assayer's own app (owner, 2026-09-23). There is no download: the
 * card is this screen, with a code that changes every minute.
 */
@ApiTags('Assayer ID card')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('assayers/me/id-card')
export class MyIdCardController {
  constructor(private readonly idCards: IdCardService) {}

  @Get()
  @OnboardingAllowed()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Your digital ID card — or why it is not issued yet' })
  async myCard(@Req() req: any) {
    return await this.idCards.myCard(ownAssayerId(req));
  }

  /** Asked again every minute while the card is on screen. */
  @Get('code')
  @AnyAuthenticated()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'The live QR and 6-digit code for your ID card' })
  async liveCode(@Req() req: any) {
    return await this.idCards.liveCode(ownAssayerId(req));
  }
}

class VerifyByCodeRequestDto {
  @IsString() @MaxLength(40)
  assayerCode: string;

  @IsString() @MaxLength(12)
  code: string;
}

/**
 * THE PUBLIC CHECK — no sign-in, for whoever the card is shown to (a bank branch, a customer).
 * Answers from the record as it is now. Throttled hard: the 6-digit route is a guess space.
 */
@ApiTags('Public ID card verification')
@Controller('public/id-card')
export class PublicIdCardController {
  constructor(private readonly idCards: IdCardService) {}

  @Get('verify/:token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check a scanned ID card QR code' })
  async verifyToken(@Param('token') token: string) {
    return await this.idCards.verifyByToken(token);
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check an ID card by its ID number and the 6-digit code shown on it' })
  async verifyCode(@Body() body: VerifyByCodeRequestDto) {
    return await this.idCards.verifyByCode(body.assayerCode, body.code);
  }

  /** The person's photograph, for a few minutes after a successful check — to match the face. */
  @Get('photo/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'The photograph a verification may show' })
  async photo(@Param('token') token: string, @Res() res: any): Promise<void> {
    const { stream, mimeType } = await this.idCards.photo(token);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}
