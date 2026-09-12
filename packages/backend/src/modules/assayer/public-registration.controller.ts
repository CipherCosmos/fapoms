import {
  Body, Controller, Get, Param, Patch, Post, UploadedFile, UseInterceptors, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import {
  IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { OnboardingDocument, EmploymentCategory } from '@fapoms/shared';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import { RegistrationApplicationService, UpdateApplicationDraftDto } from './registration-application.service';

const publicUploadMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
};

class RequestOtpDto {
  @IsString() @MinLength(6) @MaxLength(20)
  phone: string;
}

class VerifyOtpDto {
  @IsString() @MinLength(6) @MaxLength(20)
  phone: string;

  @IsString() @MinLength(4) @MaxLength(8)
  code: string;
}

class UpdateDraftRequestDto implements UpdateApplicationDraftDto {
  @IsOptional() @IsString() @MaxLength(200)
  fullName?: string;

  @IsOptional() @IsString() @MaxLength(255)
  email?: string;

  @IsOptional() @IsString()
  dateOfBirth?: string;

  @IsOptional() @IsString() @MaxLength(30)
  gender?: string;

  @IsOptional() @IsString()
  address?: string;

  @IsOptional() @IsString() @MaxLength(100)
  state?: string;

  @IsOptional() @IsString() @MaxLength(100)
  city?: string;

  @IsOptional() @IsString() @MaxLength(20)
  pincode?: string;

  @IsOptional() @IsInt() @Min(0) @Max(60)
  experienceYears?: number;

  @IsOptional() @IsString() @MaxLength(200)
  currentEmployer?: string;

  @IsOptional() @IsString() @MaxLength(300)
  expertise?: string;

  @IsOptional() @IsString() @MaxLength(200)
  availability?: string;

  @IsOptional() @IsEnum(EmploymentCategory)
  employmentCategory?: EmploymentCategory;
}

class AcceptConsentDto {
  @IsString() @MinLength(1) @MaxLength(20)
  consentVersion: string;
}

/**
 * The Appraiser Recruitment spec's Modules 2–3: candidate self-registration, reachable by the
 * emailed invite link alone — no `@Roles`/`JwtAuthGuard` on this controller at all, matching the
 * `/view-mark` pattern the web app already uses for a token-authorised public page. The token is
 * never logged or echoed back; every route re-derives its hash and re-checks expiry.
 *
 * The HR-desk registration wizard is a completely separate path (`AssayerController.create`) and
 * is untouched by any of this.
 */
@ApiTags('Public registration')
@Controller('public/registration')
export class PublicRegistrationController {
  constructor(private readonly registrationApplications: RegistrationApplicationService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resolve an invite link to its application draft' })
  async hydrate(@Param('token') token: string) {
    return { success: true, data: await this.registrationApplications.hydrate(token) };
  }

  @Post(':token/otp/request')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a mobile verification code' })
  async requestOtp(@Param('token') token: string, @Body() dto: RequestOtpDto) {
    await this.registrationApplications.requestOtp(token, dto.phone);
    return { success: true, data: { sent: true } };
  }

  @Post(':token/otp/verify')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a mobile verification code' })
  async verifyOtp(@Param('token') token: string, @Body() dto: VerifyOtpDto) {
    await this.registrationApplications.verifyOtp(token, dto.phone, dto.code);
    return { success: true, data: { verified: true } };
  }

  @Patch(':token/draft')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Autosave the profile-creation draft' })
  async updateDraft(@Param('token') token: string, @Body() dto: UpdateDraftRequestDto) {
    return { success: true, data: await this.registrationApplications.updateDraft(token, dto) };
  }

  @Post(':token/consent')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record the declaration & consent acknowledgement' })
  async acceptConsent(@Param('token') token: string, @Body() dto: AcceptConsentDto) {
    return { success: true, data: await this.registrationApplications.acceptConsent(token, dto.consentVersion) };
  }

  @Post(':token/documents/:requirement')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', publicUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a document scan for this application' })
  async uploadDocument(
    @Param('token') token: string,
    @Param('requirement') requirement: string,
    @UploadedFile() file: any,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    const data = await this.registrationApplications.uploadDocument(token, requirement as OnboardingDocument, {
      originalname: file.originalname,
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    });
    return { success: true, data };
  }

  @Post(':token/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit the application for HR review' })
  async submit(@Param('token') token: string) {
    return { success: true, data: await this.registrationApplications.submit(token) };
  }
}
