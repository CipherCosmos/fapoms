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
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateHolidayRequestDto implements CreateHolidayDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsDateString()
  date: Date;

  @IsString() @IsNotEmpty()
  type: string;

  @IsOptional() @IsArray()
  applicableStates?: string[];
}

@ApiTags('Holidays')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('holidays')
export class HolidayController {
  constructor(private readonly holidayService: HolidayService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
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
  ) {
    const { holidays, total } = await this.holidayService.findAll(page, limit, year);
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
  ) {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      return { success: false, error: 'Invalid date parameter' };
    }
    const isHoliday = await this.holidayService.isHoliday(date, stateCode);
    return {
      success: true,
      data: { isHoliday },
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Update holiday record details' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateHolidayRequestDto,
    @Req() req: any,
  ) {
    const holiday = await this.holidayService.update(id, dto, req.user.id);
    return {
      success: true,
      data: holiday,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete holiday record' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.holidayService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Holiday deleted successfully' },
    };
  }
}
