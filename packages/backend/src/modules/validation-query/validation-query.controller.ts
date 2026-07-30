import {
  Controller, Get, Post, Param, Body, UseGuards, ParseUUIDPipe, Req, Res,
  UseInterceptors, UploadedFile, UploadedFiles,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { ValidationQueryService } from './validation-query.service';
import { CreateValidationQueryDto, RespondValidationQueryDto } from './dto/validation-query.dto';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../auth/guards';
import { SystemRole } from '@fapoms/shared';
import * as fs from 'fs';
import * as path from 'path';
import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

// Persistent storage: Docker volume bind-mounted at ./packages/uploads → /app/packages/backend/uploads
const CHAT_UPLOADS_DIR = path.resolve(__dirname, '../../../../uploads/chat');

// Ensure directory exists on module load
if (!fs.existsSync(CHAT_UPLOADS_DIR)) {
  fs.mkdirSync(CHAT_UPLOADS_DIR, { recursive: true });
}

// Multer disk storage configuration — saves files directly to disk, no base64
const chatStorage = diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, CHAT_UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${uuidv4().slice(0, 8)}-${safeName}`);
  },
});

@ApiTags('Validation Queries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('validation-queries')
export class ValidationQueryController {
  constructor(private readonly validationQueryService: ValidationQueryService) {}

  // ───────────────────────────────────────────────────────────────────────────
  // FILE UPLOAD — Multer multipart/form-data (production-grade, no base64)
  // ───────────────────────────────────────────────────────────────────────────

  @Post('upload-attachment')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.ASSAYER, SystemRole.VALIDATOR, SystemRole.VALIDATION_MANAGER)
  @ApiOperation({ summary: 'Upload chat attachment via multipart form-data' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 10, { storage: chatStorage, limits: { fileSize: 25 * 1024 * 1024 } }))
  async uploadAttachments(@UploadedFiles() files: Express.Multer.File[], @Req() req: any) {
    const results = (files || []).map(file => ({
      url: `/api/v1/validation-queries/attachment/${file.filename}`,
      fileName: file.originalname,
      fileType: file.mimetype,
      size: file.size,
      uploadedBy: req.user?.role === 'ASSAYER' ? 'ASSAYER' : 'VALIDATOR',
      timestamp: new Date().toISOString(),
    }));

    return { success: true, data: results };
  }

  // Single file upload fallback (for simpler clients)
  @Post('upload-single')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.ASSAYER, SystemRole.VALIDATOR, SystemRole.VALIDATION_MANAGER)
  @ApiOperation({ summary: 'Upload single chat attachment via multipart form-data' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: chatStorage, limits: { fileSize: 25 * 1024 * 1024 } }))
  async uploadSingleAttachment(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) {
      return { success: false, message: 'No file provided' };
    }
    return {
      success: true,
      data: {
        url: `/api/v1/validation-queries/attachment/${file.filename}`,
        fileName: file.originalname,
        fileType: file.mimetype,
        size: file.size,
        uploadedBy: req.user?.role === 'ASSAYER' ? 'ASSAYER' : 'VALIDATOR',
        timestamp: new Date().toISOString(),
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // FILE DOWNLOAD — Stream from persistent Docker volume
  // ───────────────────────────────────────────────────────────────────────────

  @Get('attachment/:filename')
  @ApiOperation({ summary: 'Download/view a chat attachment file' })
  async downloadAttachment(@Param('filename') filename: string, @Res() res: Response) {
    const safeName = path.basename(filename);
    const filePath = path.join(CHAT_UPLOADS_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    const ext = path.extname(safeName).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain', '.csv': 'text/csv',
    };
    const contentType = mimeMap[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // QUERY CRUD
  // ───────────────────────────────────────────────────────────────────────────

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR)
  @ApiOperation({ summary: 'Raise a new validation query to an assayer (Data Entry / Admin)' })
  async createQuery(@Body() dto: CreateValidationQueryDto, @Req() req: any) {
    const query = await this.validationQueryService.createQuery(dto, req.user.id);
    return { success: true, data: query };
  }

  @Post(':id/respond')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.ASSAYER, SystemRole.VALIDATOR, SystemRole.VALIDATION_MANAGER)
  @ApiOperation({ summary: 'Respond/reply to an active validation query thread' })
  async respondToQuery(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondValidationQueryDto,
    @Req() req: any,
  ) {
    const query = await this.validationQueryService.respondToQuery(id, dto.response || '', req.user.id, dto.attachments);
    return { success: true, data: query };
  }

  @Post(':id/resolve')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.VALIDATION_MANAGER, SystemRole.VALIDATOR)
  @ApiOperation({ summary: 'Validator / Data Entry Head marks a responded query as RESOLVED' })
  async resolveQuery(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    const query = await this.validationQueryService.resolveQuery(id, req.user.id);
    return { success: true, data: query };
  }

  @Get('validation-case/:validationCaseId')
  @ApiOperation({ summary: 'Get all queries raised for a specific validation case' })
  async findByValidationCase(@Param('validationCaseId', ParseUUIDPipe) validationCaseId: string) {
    const list = await this.validationQueryService.findByValidationCase(validationCaseId);
    return { success: true, data: list };
  }

  @Get('assayer/:assayerId')
  @ApiOperation({ summary: 'Get all pending queries assigned to an assayer' })
  async findByAssayer(@Param('assayerId') assayerId: string) {
    const list = await this.validationQueryService.findByAssayer(assayerId);
    return { success: true, data: list };
  }
}
