import { Controller, Get, Post, Put, Body, Param, Query, UseGuards, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsUUID, IsDateString } from 'class-validator';
import { SchedulingService, CreateScheduleDto, UpdateScheduleDto } from './scheduling.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { SystemRole, ScheduleStatus } from '@fapoms/shared';

class CreateScheduleRequestDto implements CreateScheduleDto {
  @IsUUID()
  @IsNotEmpty()
  assignmentId: string;

  @IsDateString()
  @IsNotEmpty()
  scheduledDate: string;

  @IsString()
  @IsOptional()
  remarks?: string;
}

class TransitionScheduleRequestDto {
  @IsString()
  @IsNotEmpty()
  targetStatus: ScheduleStatus;

  @IsString()
  @IsOptional()
  remarks?: string;

  @IsDateString()
  @IsOptional()
  scheduledDate?: string;
}

@ApiTags('Scheduling')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('schedules')
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('scheduling:create:organization')
  @ApiOperation({ summary: 'Create a confirmed schedule from an accepted assignment' })
  async create(@Body() dto: CreateScheduleRequestDto, @Req() req: any) {
    const schedule = await this.schedulingService.create(dto, req.user.id);
    return {
      success: true,
      data: schedule,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List all active schedules' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('status') status?: ScheduleStatus,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const { schedules, total } = await this.schedulingService.findAll(
      Number(page), Number(limit), status, dateFrom, dateTo,
    );
    return {
      success: true,
      data: schedules,
      meta: {
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
        },
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details for a single schedule by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const schedule = await this.schedulingService.findOne(id);
    return {
      success: true,
      data: schedule,
    };
  }

  @Post(':id/transition')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER, SystemRole.OPERATIONS_EXECUTIVE)
  @RequirePermissions('scheduling:update:organization')
  @ApiOperation({ summary: 'Transition schedule state' })
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionScheduleRequestDto,
    @Req() req: any,
  ) {
    const schedule = await this.schedulingService.transition(id, dto.targetStatus, req.user.id, dto.remarks, dto.scheduledDate);
    return {
      success: true,
      data: schedule,
    };
  }

  @Get('assayer-workload')
  @ApiOperation({ summary: 'Get number of confirmed/tentative schedules for an assayer around a date' })
  async getAssayerWorkload(
    @Query('assayerId') assayerId: string,
    @Query('date') date: string,
  ) {
    if (!assayerId || !date) {
      return { success: true, data: { count: 0, schedules: [] } };
    }
    const dt = new Date(date);
    const weekStart = new Date(dt);
    weekStart.setDate(dt.getDate() - dt.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const data = await this.schedulingService.getAssayerWorkloadInRange(assayerId, weekStart, weekEnd);
    return { success: true, data };
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Get unified activity timeline for a schedule' })
  async getTimeline(@Param('id', ParseUUIDPipe) id: string) {
    const timeline = await this.schedulingService.getTimeline(id);
    return {
      success: true,
      data: timeline,
    };
  }
}
