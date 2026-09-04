import {
  Controller, Get, Post, Delete, Body, Req, HttpCode, HttpStatus, UseGuards, BadRequestException,
} from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, AnyAuthenticated } from './guards';
import { MfaService } from './mfa.service';

class MfaCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}

/**
 * Self-service MFA setup for the signed-in user. Every route requires an authenticated session
 * (JwtAuthGuard); MFA is opt-in, so an account with nothing enrolled is unaffected until it uses
 * these. Enrol/disable/regenerate throttled to blunt automated abuse.
 *
 * KNOWN RESIDUAL (documented, step-up auth is out of Wave 2 scope): these accept a live session and
 * do NOT re-prompt for the password, so an attacker holding a stolen session could change MFA. See
 * MfaService's note; mitigations are session revocation and the audit trail.
 */
@ApiTags('MFA')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'My MFA status (enrolled / confirmed / recovery codes left)' })
  async status(@Req() req: any) {
    return { success: true, data: await this.mfa.status(req.user.id) };
  }

  /** Begin TOTP enrolment — returns the otpauth URI + secret to render a QR. Not active until confirmed. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('totp/enrol')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start TOTP enrolment (returns otpauth URI + secret for the QR)' })
  async enrol(@Req() req: any) {
    const account = req.user.email || req.user.username || req.user.id;
    return { success: true, data: await this.mfa.beginEnrol(req.user.id, account) };
  }

  /** Confirm enrolment by proving one code; activates MFA and returns the one-time recovery codes. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('totp/confirm')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm & activate TOTP; returns single-use recovery codes (shown once)' })
  async confirm(@Body() dto: MfaCodeDto, @Req() req: any) {
    const { recoveryCodes } = await this.mfa.confirmEnrol(req.user.id, dto.code);
    return { success: true, data: { recoveryCodes } };
  }

  /** Turn MFA off for my account. */
  @Delete()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Disable my MFA' })
  async disable(@Req() req: any) {
    await this.mfa.disable(req.user.id, req.user.id);
    return { success: true, data: { message: 'MFA disabled.' } };
  }

  /** Replace my recovery codes (invalidates the old set); returns the new codes once. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('recovery/regenerate')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Regenerate my recovery codes (old ones stop working)' })
  async regenerate(@Req() req: any) {
    return { success: true, data: { recoveryCodes: await this.mfa.regenerateRecoveryCodes(req.user.id) } };
  }
}
