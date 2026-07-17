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
import { IsString, IsEmail, IsNotEmpty, IsOptional, MinLength, IsArray } from 'class-validator';
import { UserService, CreateUserDto, UpdateUserDto } from './user.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

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

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@Req() req: any) {
    return {
      success: true,
      data: this.sanitizeUser(req.user),
    };
  }

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
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

  @Get(':id')
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
  @ApiOperation({ summary: 'Update user' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
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

  /** Remove sensitive fields before sending to client */
  private sanitizeUser(user: any) {
    const { passwordHash, failedLoginAttempts, lockedUntil, ...safe } = user;
    return safe;
  }
}
