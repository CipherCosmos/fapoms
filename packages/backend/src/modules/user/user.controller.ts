/**
 * FAPOMS — User Controller
 *
 * API endpoints for user management.
 * Protected by JWT authentication and role-based authorization.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsEmail, IsNotEmpty, IsOptional, MinLength, IsArray, IsEnum } from 'class-validator';
import { UserService, CreateUserDto, UpdateUserDto } from './user.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, AnyAuthenticated } from '../auth/guards';
import { SystemRole, UserStatus } from '@fapoms/shared';

class CreateUserRequestDto implements CreateUserDto {
  @IsString() @IsNotEmpty()
  username: string;

  @IsEmail()
  email: string;

  @IsString() @MinLength(8)
  password: string;

  @IsString() @IsNotEmpty()
  firstName: string;

  @IsString() @IsNotEmpty()
  lastName: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  departmentId?: string;

  @IsOptional() @IsArray()
  roleIds?: string[];
}

class AssignRolesDto {
  @IsArray()
  roleIds: string[];
}

class BulkSetStatusDto {
  @IsArray() @IsNotEmpty()
  ids: string[];

  @IsEnum(UserStatus)
  status: UserStatus;
}

/**
 * The controller previously typed this body as the bare `UpdateUserDto`
 * interface, which class-validator cannot see — nothing about a PUT request
 * was actually validated, including `status`, which accepted any string at all
 * rather than one of the real UserStatus values.
 */
class UpdateUserRequestDto implements UpdateUserDto {
  @IsOptional() @IsString()
  firstName?: string;

  @IsOptional() @IsString()
  lastName?: string;

  @IsOptional() @IsString()
  phone?: string;

  @IsOptional() @IsString()
  departmentId?: string;

  @IsOptional() @IsEnum(UserStatus)
  status?: UserStatus;
}

class ResetPasswordRequestDto {
  @IsString() @MinLength(8)
  newPassword: string;
}

class SelfUpdateProfileDto {
  @IsOptional() @IsString()
  firstName?: string;

  @IsOptional() @IsString()
  lastName?: string;

  @IsOptional() @IsString()
  phone?: string;
}

class SelfChangePasswordDto {
  @IsString() @IsNotEmpty()
  currentPassword: string;

  @IsString() @MinLength(8)
  newPassword: string;
}

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@Req() req: any) {
    return {
      success: true,
      data: this.sanitizeUser(req.user),
    };
  }

  @Put('me')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Self update personal details (first name, last name, phone)' })
  async updateMe(@Body() dto: SelfUpdateProfileDto, @Req() req: any) {
    const updated = await this.userService.updateUser(req.user.id, dto, req.user.id);
    return {
      success: true,
      data: this.sanitizeUser(updated),
    };
  }

  @Post('me/change-password')
  @AnyAuthenticated()
  @ApiOperation({ summary: 'Change current user password' })
  async changePassword(@Body() dto: SelfChangePasswordDto, @Req() req: any) {
    await this.userService.changePassword(req.user.id, dto.currentPassword, dto.newPassword);
    return {
      success: true,
      data: { message: 'Password changed successfully.' },
    };
  }

  @Post('bulk/status')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:edit:organization')
  @ApiOperation({ summary: 'Activate or suspend a batch of users in one operation' })
  async bulkSetStatus(@Body() dto: BulkSetStatusDto, @Req() req: any) {
    const result = await this.userService.bulkSetStatus(dto.ids, dto.status, req.user.id);
    return { success: true, data: result };
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:create:organization')
  @ApiOperation({ summary: 'Create a new user' })
  async create(@Body() dto: CreateUserRequestDto, @Req() req: any) {
    const user = await this.userService.createUser(dto, req.user.id);
    return {
      success: true,
      data: this.sanitizeUser(user),
    };
  }

  @Get()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'List all users' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { users, total } = await this.userService.findAll(page, limit);
    return {
      success: true,
      data: users.map(this.sanitizeUser),
      meta: {
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  @Get('roles')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'List all available roles' })
  async findAllRoles() {
    const roles = await this.userService.findAllRoles();
    return {
      success: true,
      data: roles,
    };
  }

  @Get(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.HR_MANAGER)
  @ApiOperation({ summary: 'Get user by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.userService.findById(id);
    return {
      success: true,
      data: this.sanitizeUser(user),
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:edit:organization')
  @ApiOperation({ summary: 'Update user' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRequestDto,
    @Req() req: any,
  ) {
    const user = await this.userService.updateUser(id, dto, req.user.id);
    return {
      success: true,
      data: this.sanitizeUser(user),
    };
  }

  @Put(':id/roles')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:edit:organization')
  @ApiOperation({ summary: 'Assign roles to user' })
  async assignRoles(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRolesDto,
    @Req() req: any,
  ) {
    const user = await this.userService.assignRoles(
      id,
      dto.roleIds,
      req.user.id,
    );
    return {
      success: true,
      data: this.sanitizeUser(user),
    };
  }

  @Post(':id/unlock')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:edit:organization')
  @ApiOperation({ summary: 'Clear a lockout without changing the password' })
  async unlockAccount(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const user = await this.userService.unlockAccount(id, req.user.id);
    return { success: true, data: this.sanitizeUser(user) };
  }

  @Post(':id/reset-password')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @RequirePermissions('user:edit:organization')
  @ApiOperation({ summary: 'Admin resets a user\'s password' })
  async resetPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordRequestDto,
    @Req() req: any,
  ) {
    await this.userService.resetPassword(id, dto.newPassword, req.user.id);
    return { success: true, data: { message: 'Password reset.' } };
  }

  /** Remove sensitive fields before sending to client */
  /**
   * Only the password hash is a secret. `failedLoginAttempts` and `lockedUntil`
   * were stripped here too, on every response — meaning the only people who can
   * even reach this admin-gated controller had no way to see that an account
   * was locked out, or why, and no signal that a reset actually needed to touch
   * the lock state (see UserService.resetPassword).
   */
  private sanitizeUser(user: any) {
    const { passwordHash, ...safe } = user;
    return safe;
  }
}
