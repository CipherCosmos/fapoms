/**
 * FAPOMS — Holiday Controller
 *
 * REST API endpoints for holiday calendar administration (Part 5 §11).
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsDateString, IsArray } from 'class-validator';

import { HolidayService, CreateHolidayDto } from './holiday.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, RolesFallbackPermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';
import { ParsePagePipe } from '../../infrastructure/http/parse-page.pipe';

class CreateHolidayRequestDto implements CreateHolidayDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsDateString()
  date: string | Date;

  @IsString() @IsNotEmpty()
  type: string;

  @IsOptional() @IsArray()
  applicableStates?: string[];

  @IsOptional() @IsString()
  clientId?: string;
}

/** Partial edit — every field optional so one change doesn't have to resend the rest. */
class UpdateHolidayRequestDto {
  @IsOptional() @IsString()
  name?: string;

  @IsOptional() @IsDateString()
  date?: string | Date;

  @IsOptional() @IsString()
  type?: string;

  @IsOptional() @IsArray()
  applicableStates?: string[];

  @IsOptional() @IsString()
  clientId?: string;
}

@ApiTags('Holidays')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
// Internal book: staff only. Individual routes narrow this further.
@Roles(...STAFF_ROLES)
@Controller('holidays')
export class HolidayController {
  constructor(private readonly holidayService: HolidayService) {}

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  // Reference data — see the note in ZoneController.create. `holiday:*` did not exist, so
  // every role including SUPER_ADMINISTRATOR was refused and the calendar could never be edited.
  @RequirePermissions('reference_data:create:organization')
  @ApiOperation({ summary: 'Register a national or regional holiday' })
  async create(@Body() dto: CreateHolidayRequestDto, @Req() req: any) {
    const holiday = await this.holidayService.create(dto, req.user.id);
    return {
      success: true,
      data: holiday,
    };
  }

  @Get()
  /**
   * The holiday calendar is reference data, and a role granted reference data may read it.
   *
   * The class-level `@Roles(...STAFF_ROLES)` is a closed list of built-in names, so a role built in
   * Admin → Roles was refused — which is why bank holidays stopped shading the `/scheduling`
   * calendar for one, silently, on the screen where "is that date a holiday" is the question.
   * `@RolesFallbackPermissions` and not `@RequirePermissions` for the same reason as
   * `GET /assignments`: PRODUCT_SUPPORT is on STAFF_ROLES and holds no grants, so requiring a
   * permission outright would take this list away from a role that reads it today.
   *
   * Read only. Creating, editing and deleting a holiday stay on `canManageHolidays`' gate.
   */
  @RolesFallbackPermissions('reference_data:view:organization')
  @ApiOperation({ summary: 'List and filter holiday records' })
  async findAll(
    // Same gap, same fix as ZoneController.findAll: an unguarded `page`/`limit` reached the
    // query builder as a bare Number(...), and `?page=0`/`-1`/`abc` produced a `skip` Postgres
    // or TypeORM refuse outright — an unhandled 500 for a request that should just return page one.
    @Query('page', new ParsePagePipe()) page: number,
    @Query('limit', new ParseLimitPipe({ default: 50, max: 500 })) limit: number,
    @Query('year') year?: number,
    @Query('clientId') clientId?: string,
  ) {
    const { holidays, total } = await this.holidayService.findAll(page, limit, year, clientId);
    return {
      success: true,
      data: holidays,
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

  @Get('check')
  @ApiOperation({ summary: 'Verify if a date is a holiday' })
  async checkHoliday(
    @Query('date') dateString: string,
    @Query('stateCode') stateCode?: string,
    @Query('clientId') clientId?: string,
  ) {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return { success: false, error: 'Invalid date parameter' };
    }
    const isHoliday = await this.holidayService.isHoliday(date, stateCode, clientId);
    return {
      success: true,
      data: { isHoliday },
    };
  }

  @Put(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('reference_data:edit:organization')
  @ApiOperation({ summary: 'Update holiday record details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateHolidayRequestDto,
    @Req() req: any,
  ) {
    const holiday = await this.holidayService.update(id, dto, req.user.id);
    return {
      success: true,
      data: holiday,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('reference_data:delete:organization')
  @ApiOperation({ summary: 'Soft delete holiday record' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.holidayService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Holiday deleted successfully' },
    };
  }
}
