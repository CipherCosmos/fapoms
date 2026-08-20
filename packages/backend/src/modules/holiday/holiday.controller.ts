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
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole } from '@fapoms/shared';

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
  @ApiOperation({ summary: 'List and filter holiday records' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 50,
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
