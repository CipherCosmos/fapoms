import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors,
  BadRequestException, Res, ParseIntPipe, Headers,
} from '@nestjs/common';
import { issueRegistrationScanLink, registrationScanLinkIsValid, REGISTRATION_SCAN_LINK_TTL_SECONDS } from './registration-scan-link';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import {
  IsArray, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { OnboardingDocument, EmploymentCategory } from '@fapoms/shared';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { MAX_UPLOAD_BYTES } from '../document/upload-validation';
import {
  RegistrationApplicationService, UpdateApplicationDraftDto, REGISTRATION_SESSION_HEADER,
} from './registration-application.service';

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

/**
 * Exported so the desk's own draft route can extend it rather than re-declare it. The two doors
 * write the same fields to the same row; a second copy of these decorators is a second place for
 * a length limit to drift.
 */
export class UpdateDraftRequestDto implements UpdateApplicationDraftDto {
  @IsOptional() @IsString() @MaxLength(200)
  fullName?: string;

  /** Their own number, correctable until they verify it. */
  @IsOptional() @IsString() @MinLength(6) @MaxLength(20)
  mobile?: string;

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

  /**
   * People who can vouch for the candidate — up to three. Normalized server-side (trimmed,
   * empties dropped, capped); submit refuses an application with nobody ringable on it.
   */
  @IsOptional() @IsArray()
  references?: Array<Record<string, unknown>>;

  /**
   * Who referred them — the source reference. The candidate may fill it only while HR has not;
   * the service refuses a change to HR's entry. `null` clears their own.
   */
  @IsOptional() @IsObject()
  sourceReferral?: Record<string, unknown> | null;

  /**
   * The rest of the person, keyed by the assayer record's own field names.
   *
   * Unvalidated as a shape on purpose: the allow-list is a single shared rule
   * (`pickRegistrationRecordFields`), and duplicating it as thirty decorators here is exactly how
   * the candidate form and the desk wizard drifted apart in the first place. The service filters
   * what it will keep and checks PAN, IFSC and Aadhaar before storing any of it.
   */
  @IsOptional() @IsObject()
  record?: Record<string, unknown>;
}

class AcceptConsentDto {
  @IsString() @MinLength(1) @MaxLength(20)
  consentVersion: string;
}

class WithdrawConsentDto {
  /**
   * Optional, and deliberately so: the DPDP Act makes withdrawal as easy as consent, and a required
   * "why" is friction in the way of a right.
   */
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
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
  async hydrate(@Param('token') token: string, @Headers(REGISTRATION_SESSION_HEADER) session?: string) {
    // Without the session key a successful code minted, saved identity numbers and scans stay out.
    return await this.registrationApplications.hydrate(token, session);
  }

  @Post(':token/otp/request')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Send a mobile verification code (by text when SMS is set up, else by email)' })
  async requestOtp(
    @Param('token') token: string,
    @Body() dto: RequestOtpDto,
    @Headers(REGISTRATION_SESSION_HEADER) session?: string,
  ) {
    // Which channel carried it and a masked destination, so the page says where to look.
    // The code itself is NEVER returned to the caller or logged.
    const result = await this.registrationApplications.requestOtp(token, dto.phone, session);
    return { sent: true, ...result };
  }

  @Post(':token/otp/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify a mobile verification code' })
  async verifyOtp(@Param('token') token: string, @Body() dto: VerifyOtpDto) {
    /*
      `channel` says what the code proved (a text proves the mobile; an email only the mailbox).
      `sessionKey` is what the client sends back in the `x-registration-session` header to read its
      saved answers and scans — returned once, stored only as a hash, expiring after
      `sessionExpiresInSeconds` of disuse.
    */
    const result = await this.registrationApplications.verifyOtp(token, dto.phone, dto.code);
    return { verified: true, ...result };
  }

  @Patch(':token/draft')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Autosave the profile-creation draft' })
  async updateDraft(
    @Param('token') token: string,
    @Body() dto: UpdateDraftRequestDto,
    @Headers(REGISTRATION_SESSION_HEADER) session?: string,
  ) {
    return await this.registrationApplications.updateDraft(token, dto, session);
  }

  @Get(':token/lookup/ifsc/:code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'IFSC → bank lookup for the candidate bank form (invite-token gated)' })
  async lookupIfsc(@Param('token') token: string, @Param('code') code: string) {
    return await this.registrationApplications.lookupIfsc(token, code);
  }

  @Get(':token/lookup/pincode/:pin')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Pincode → district/city/state lookup for the candidate address form (invite-token gated)' })
  async lookupPincode(@Param('token') token: string, @Param('pin') pin: string) {
    return await this.registrationApplications.lookupPincode(token, pin);
  }

  @Get(':token/check-phone/:phone')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Check if a mobile phone number already conflicts with an active appraiser or application' })
  async checkPhone(@Param('token') token: string, @Param('phone') phone: string) {
    /*
      Returned as it comes back, because the service already answers in this shape.

      This used to be `conflict ? {conflict: true, …} : {conflict: false}` — and the service's
      "no, that number is free" answer is an OBJECT, `{conflict: false}`, which is truthy. So the
      ternary took the conflict branch for EVERY number, with `conflict.message` undefined, and
      the candidate's form fell back to its own sentence: "This mobile number is already
      registered with someone else." Nobody could get past step one with any number at all.
    */
    return await this.registrationApplications.checkPhoneForToken(token, phone);
  }

  @Post(':token/consent')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record the declaration & consent acknowledgement' })
  async acceptConsent(@Param('token') token: string, @Body() dto: AcceptConsentDto) {
    return await this.registrationApplications.acceptConsent(token, dto.consentVersion);
  }

  /**
   * Taking it back. Same link, same effort as giving it — see `withdrawConsent`, which erases the
   * answers and deletes the scans rather than just marking a flag.
   */
  @Post(':token/consent/withdraw')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Withdraw consent and erase what was given' })
  async withdrawConsent(@Param('token') token: string, @Body() dto: WithdrawConsentDto) {
    return await this.registrationApplications.withdrawConsent(token, dto.reason);
  }

  @Post(':token/documents/:requirement')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', publicUploadMulterOptions), FileScanInterceptor)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a document scan for this application',
    description: 'Appends by default (another page). `?replace=true` puts the file in place of every file already on the requirement.',
  })
  async uploadDocument(
    @Param('token') token: string,
    @Param('requirement') requirement: string,
    @UploadedFile() file: any,
    @Query('replace') replace?: string,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('No file was uploaded. Choose a file and try again.');
    }
    const data = await this.registrationApplications.uploadDocument(token, requirement as OnboardingDocument, {
      originalname: file.originalname,
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    }, { replace: replace === 'true' || replace === '1' });
    return { success: true, data };
  }

  /**
   * Taking one file off a requirement. Throttled like the upload it undoes; gated like it too (see
   * `removeDocumentFile`). Answers the row as it now stands — `filePaths` may be empty.
   */
  @Delete(':token/documents/:requirement/file/:index')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Remove one attached file from a document requirement' })
  async removeDocumentFile(
    @Param('token') token: string,
    @Param('requirement') requirement: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return await this.registrationApplications.removeDocumentFile(
      token, requirement as OnboardingDocument, index,
    );
  }

  @Post(':token/submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit the application for HR review' })
  async submit(@Param('token') token: string) {
    return await this.registrationApplications.submit(token);
  }

  /**
   * A two-minute link to one scan, for a PDF the phone must hand to a viewer that cannot send the
   * session header. Only a caller who unlocked the form this session gets one (the same check the
   * scan itself makes), and the link opens that one page and nothing else.
   */
  @Get(':token/documents/:requirement/file/:index/link')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'A short-lived link to one attached scan, for a viewer that cannot send headers' })
  async documentLink(
    @Param('token') token: string,
    @Param('requirement') requirement: string,
    @Param('index', ParseIntPipe) index: number,
    @Headers(REGISTRATION_SESSION_HEADER) session?: string,
  ): Promise<{ path: string; expiresInSeconds: number }> {
    await this.registrationApplications.documentFileKeyForToken(token, requirement as OnboardingDocument, index, session);
    const t = issueRegistrationScanLink(token, requirement, index);
    return {
      path: `/public/registration/${encodeURIComponent(token)}/documents/${encodeURIComponent(requirement)}/file/${index}?t=${encodeURIComponent(t)}`,
      expiresInSeconds: REGISTRATION_SCAN_LINK_TTL_SECONDS,
    };
  }

  @Get(':token/documents/:requirement/file/:index')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Stream one attached scan for candidate preview' })
  async readDocument(
    @Param('token') token: string,
    @Param('requirement') requirement: string,
    @Param('index', ParseIntPipe) index: number,
    @Res() res: any,
    @Headers(REGISTRATION_SESSION_HEADER) session?: string,
    @Query('t') scanLink?: string,
  ): Promise<void> {
    // Refused (403) unless this caller unlocked the link with a code this session, or carries a
    // scan link signed for exactly this page (see `documentLink`).
    const { key, fileName } = await this.registrationApplications.documentFileKeyForToken(
      token, requirement as OnboardingDocument, index, session,
      registrationScanLinkIsValid(scanLink, token, requirement, index),
    );
    const stream = await this.registrationApplications.openDocumentStream(key);
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    stream.pipe(res);
  }
}
