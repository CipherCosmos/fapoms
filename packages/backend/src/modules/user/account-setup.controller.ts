import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/guards';
import { UserService } from './user.service';

class CompleteSetupDto {
  @IsString() @MinLength(10) @MaxLength(128)
  password: string;
}

/**
 * WHERE SOMEBODY CHOOSES THEIR OWN PASSWORD.
 *
 * Public by necessity and by design: the person holding this link has no account they can sign in
 * with yet — that is the entire point. The link is the credential, so it is long, hashed at rest,
 * short-lived, single-use, and rate-limited here.
 *
 * Modelled on the candidate registration door (`PublicRegistrationController`), which solved the
 * same problem for people outside the company.
 */
@ApiTags('Account setup')
@Controller('public/account-setup')
export class AccountSetupController {
  constructor(private readonly users: UserService) {}

  /**
   * Who this link is for, so the page can greet them — and nothing else.
   *
   * Deliberately returns the same "not valid" answer for a token that never existed, one that has
   * expired and one already spent: distinguishing them would tell somebody feeding in guesses
   * which links had once been real.
   */
  @Public()
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check a password link and say who it belongs to' })
  async check(@Param('token') token: string) {
    const user = await this.users.findByPasswordSetupToken(token);
    if (!user) return { valid: false };
    return {
      valid: true,
      displayName: user.displayName,
      // The address is shown so the person can see the account they are setting up is theirs.
      email: user.email,
      expiresAt: user.passwordSetupExpiresAt,
    };
  }

  @Public()
  @Post(':token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Set the password this link was issued for' })
  async complete(@Param('token') token: string, @Body() dto: CompleteSetupDto) {
    const user = await this.users.completePasswordSetup(token, dto.password);
    // No session is issued here. Setting a password and signing in are different acts, and one of
    // them should go through the login door with everything that guards it.
    return { ok: true, username: user.username };
  }
}
