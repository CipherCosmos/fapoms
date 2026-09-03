/**
 * FAPOMS — JWT Strategy
 *
 * Validates JWT tokens on protected routes.
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService, JwtPayload } from './auth.service';
import { AUTH_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      /**
       * Authorization header only.
       *
       * This previously also accepted `?token=` and `?access_token=`, which put a full session
       * JWT — 15 minutes of the holder's entire authority, every role and permission — into a
       * URL. URLs are logged by load balancers, reverse proxies and the browser's own history,
       * and leak to third parties through the `Referer` header. A token in a query string is a
       * token you have to assume is disclosed.
       *
       * Nothing needed it. The two places that legitimately cannot send a header — the
       * assayer app opening a PDF through `Linking.openURL()`, and chat attachments — go
       * through `DocumentAccessTokenService` instead: an HMAC bound to one document id,
       * expiring in five minutes, signed with `DOCUMENT_TOKEN_SECRET`, and useless for
       * anything else. That is the right instrument for a link, and it already exists.
       *
       * Socket.IO is unaffected: `EventsGateway` reads the handshake and verifies it with
       * `JwtService` directly, never through this strategy.
       */
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET', 'dev-secret'),
    });
  }

  async validate(payload: JwtPayload) {
    const user = await this.authService.validateJwtPayload(payload);
    if (!user) {
      throw withCode(
        new UnauthorizedException('User not found or inactive'),
        AUTH_ERROR_CODES.ACCOUNT_INACTIVE,
      );
    }
    return user;
  }
}
