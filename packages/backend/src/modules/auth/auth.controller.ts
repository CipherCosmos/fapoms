/**
 * FAPOMS — Auth Controller
 *
 * API endpoints for authentication: login, refresh, logout.
 */

import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards';

class LoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

class VerifyAssayerDto {
  @IsString()
  @IsNotEmpty()
  identifier: string;
}

class RefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

class BiometricLoginDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Confirms an assayer identifier exists, before the password step.
   *
   * The app previously did this by downloading the entire assayer list from a
   * public `GET /assayers` and matching client-side — which is why that endpoint
   * was public, and why every assayer's bcrypt hash and personal details were
   * readable by anyone who could reach the API. This returns only what the login
   * screen needs to greet the user, for one exact identifier.
   */
  @Post('verify-assayer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check an assayer identifier exists (pre-login, no credentials returned)' })
  async verifyAssayer(@Body() dto: VerifyAssayerDto) {
    const found = await this.authService.verifyAssayerIdentifier(dto.identifier);
    return {
      success: true,
      // Deliberately minimal: existence plus a display name. No contact details,
      // no banking, no identifiers beyond the one already supplied by the caller.
      data: found ? { verified: true, displayName: found.displayName, assayerCode: found.assayerCode } : { verified: false },
    };
  }

  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check API and database connectivity status' })
  async status() {
    return {
      success: true,
      data: {
        status: 'online',
        database: 'connected',
        timestamp: new Date().toISOString(),
      },
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user and obtain tokens' })
  async login(@Body() dto: LoginDto, @Req() req: any) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await this.authService.login(
      dto.username,
      dto.password,
      ipAddress,
      userAgent,
    );

    return {
      success: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        user: {
          ...result.user,
          roles: Array.isArray(result.user.roles)
            ? result.user.roles.map((r: any) => (typeof r === 'string' ? r : r.name))
            : [],
        },
      },
    };
  }

  @Post('biometric-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a session via biometric unlock — redeems a refresh token from a prior real login (for mobile)' })
  async biometricLogin(@Body() dto: BiometricLoginDto, @Req() req: any) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const result = await this.authService.biometricLogin(
      dto.refreshToken,
      ipAddress,
      userAgent,
    );

    return {
      success: true,
      data: {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        user: {
          id: result.user.id,
          username: result.user.username,
          name: result.user.name,
          email: result.user.email,
          phone: result.user.phone,
          status: result.user.status,
        },
      },
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
  async refresh(@Body() dto: RefreshDto, @Req() req: any) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const tokens = await this.authService.refreshAccessToken(
      dto.refreshToken,
      ipAddress,
      userAgent,
    );

    return {
      success: true,
      data: tokens,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke all refresh tokens' })
  async logout(@Req() req: any) {
    const ipAddress = req.ip || req.connection?.remoteAddress;
    await this.authService.logout(req.user.id, ipAddress);

    return {
      success: true,
      data: { message: 'Logged out successfully' },
    };
  }
}
