import {
  Controller, Get, Post, Delete, Body, Query, Req, HttpCode, HttpStatus, UseGuards, BadRequestException,
} from '@nestjs/common';
import { IsString, IsNotEmpty, IsOptional, IsEmail, IsIn } from 'class-validator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, AnyAuthenticated } from './guards';
import { MfaService } from './mfa.service';

class MfaCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;
}

class EmailEnrolDto {
  // Optional: defaults to the account's own email when omitted.
  @IsOptional()
  @IsEmail()
  email?: string;
}

class SmsEnrolDto {
  @IsString()
  @IsNotEmpty()
  phone: string;
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

  /** Begin email-OTP enrolment — sends a code to the address (defaults to the account's email). */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('email/enrol')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start email second-factor enrolment (sends a code to confirm the address)' })
  async enrolEmail(@Body() dto: EmailEnrolDto, @Req() req: any) {
    const dest = dto.email || req.user.email;
    if (!dest) throw new BadRequestException('No email address on file — provide one to enrol email as a second factor.');
    return { success: true, data: await this.mfa.beginDeliveredEnrol(req.user.id, 'EMAIL', dest) };
  }

  /** Confirm & activate the email factor with the code just sent. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('email/confirm')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm & activate email as a second factor' })
  async confirmEmail(@Body() dto: MfaCodeDto, @Req() req: any) {
    const { recoveryCodes } = await this.mfa.confirmEnrol(req.user.id, dto.code, 'EMAIL');
    return { success: true, data: { recoveryCodes } };
  }

  /** Begin SMS-OTP enrolment — sends a code to the phone. Refused if SMS is not configured server-side. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('sms/enrol')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start SMS second-factor enrolment (sends a code to confirm the number)' })
  async enrolSms(@Body() dto: SmsEnrolDto, @Req() req: any) {
    return { success: true, data: await this.mfa.beginDeliveredEnrol(req.user.id, 'SMS', dto.phone) };
  }

  /** Confirm & activate the SMS factor with the code just sent. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('sms/confirm')
  @AnyAuthenticated()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm & activate SMS as a second factor' })
  async confirmSms(@Body() dto: MfaCodeDto, @Req() req: any) {
    const { recoveryCodes } = await this.mfa.confirmEnrol(req.user.id, dto.code, 'SMS');
    return { success: true, data: { recoveryCodes } };
  }

  /**
   * Turn MFA off. With no `factor` this removes every second factor on the account; with
   * `?factor=TOTP|EMAIL|SMS` it removes just that one (leaving any others, and their shared
   * recovery codes, in place unless it was the last).
   */
  @Delete()
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Disable my MFA (all factors, or one via ?factor=)' })
  async disable(@Req() req: any, @Query('factor') factor?: string) {
    const f = factor ? String(factor).toUpperCase() : undefined;
    if (f && !['TOTP', 'EMAIL', 'SMS'].includes(f)) throw new BadRequestException('Unknown factor.');
    await this.mfa.disable(req.user.id, req.user.id, f as any);
    return { success: true, data: { message: f ? `${f} factor removed.` : 'MFA disabled.' } };
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
