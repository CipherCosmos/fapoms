/**
 * FAPOMS — Branch Controller
 *
 * API endpoints for Branch CRUD and Excel lists upload imports (Part 5 §4).
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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

import { BranchService, CreateBranchDto } from './branch.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';

class CreateBranchRequestDto implements CreateBranchDto {
  @IsString() @IsNotEmpty()
  branchCode: string;

  @IsOptional() @IsString()
  solId?: string;

  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsNotEmpty()
  address: string;

  @IsString() @IsNotEmpty()
  state: string;

  @IsString() @IsNotEmpty()
  district: string;

  @IsString() @IsNotEmpty()
  city: string;

  @IsOptional() @IsString()
  pincode?: string;

  @IsOptional() @IsNumber()
  latitude?: number;

  @IsOptional() @IsNumber()
  longitude?: number;

  @IsOptional() @IsString()
  clientId?: string;
}

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('branches')
export class BranchController {
  constructor(private readonly branchService: BranchService) {}

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new branch manually with geolocation point' })
  async create(@Body() dto: CreateBranchRequestDto, @Req() req: any) {
    const branch = await this.branchService.create(dto, req.user.id);
    return {
      success: true,
      data: branch,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List and filter master bank branches' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('clientId') clientId?: string,
  ) {
    const { branches, total } = await this.branchService.findAll(page, limit, clientId);
    return {
      success: true,
      data: branches,
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
  @ApiOperation({ summary: 'Get details for a single branch by ID' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const branch = await this.branchService.findOne(id);
    return {
      success: true,
      data: branch,
    };
  }

  @Put(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update branch details manually' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBranchRequestDto,
    @Req() req: any,
  ) {
    const branch = await this.branchService.update(id, dto, req.user.id);
    return {
      success: true,
      data: branch,
    };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete branch record' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.branchService.remove(id, req.user.id);
    return {
      success: true,
      data: { message: 'Branch deleted successfully' },
    };
  }

  @Post('import/:clientId')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload and parse an Excel sheet branch list based on Client column mappings' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  async importExcel(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      return { success: false, error: 'No file uploaded.' };
    }
    const result = await this.branchService.importExcel(file.buffer, clientId, req.user.id);
    return {
      success: true,
      data: result,
    };
  }
}
