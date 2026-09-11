import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  IsString, IsNotEmpty, IsOptional, IsObject, IsArray, IsNumber, IsInt, IsEmail, IsBoolean, IsEnum, Min, Max, IsUUID, MaxLength,
  ValidateBy, ValidationOptions, ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ClientService, CreateClientDto, UpdateClientDto, CreateContactDto, UpdateContactDto, CreateContractDto, UpdateContractDto, UpdateBillingDto } from './client.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, ClientLifecycleStatus, ContractStatus, isValidGstin, isValidPan } from '@fapoms/shared';
import { QualificationScoreService } from '../assayer/qualification-score.service';
import { GlobalScopeFilter, GlobalScope } from '../../infrastructure/scope/global-scope';
import { ParsePagePipe } from '../../infrastructure/http/parse-page.pipe';
import { IsHttpUrl, IsIndianMobile } from '../../infrastructure/http/format-validators';
import { ParseLimitPipe } from '../../infrastructure/http/parse-limit.pipe';

/**
 * Trim before validating, so a field of spaces fails `@IsNotEmpty` like the empty string it is.
 *
 * `"   "` satisfies both the browser's `required` attribute and class-validator's non-empty check,
 * which let a client be created with a blank code and name. It rendered as an empty row in the
 * clients list and, worse, as a selectable "( )" entry in every downstream client picker.
 */
const TrimmedString = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/**
 * `taxId` is presented to the operator as "e.g., GSTIN / PAN" (see `EditClientModal`'s
 * placeholder) because a client's own registration paperwork is filed under either, depending on
 * whether the client is GST-registered — an unregistered proprietorship or an individual client
 * may only have a PAN. Same decorator pattern `assayer.controller.ts`'s `identityFormatRule`
 * uses for PAN/IFSC/Aadhaar: an absent or null field is skipped by `@IsOptional()`, and an empty
 * string passes so an edit that clears the field is never blocked by the very rule meant to keep
 * junk out. What is refused is a value that matches neither shape at all.
 */
const IsGstinOrPanFormat = (options?: ValidationOptions): PropertyDecorator =>
  ValidateBy({
    name: 'isGstinOrPanFormat',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' && (value.trim() === '' || isValidGstin(value) || isValidPan(value)),
      defaultMessage: () =>
        "This doesn't look like a GSTIN or a PAN — enter one of the two, e.g. 27AAPFU0939F1ZV or ABCDE1234F.",
    },
  }, options);

/**
 * Bounds, not just types.
 *
 * `defaultRadius`, `penaltyRate` and `maxResponseTimeHours` were bare `@IsNumber()`, so the
 * configuration screen's unlabelled boxes could store a −50% penalty rate, a 900 000 km search
 * radius or a response time of zero hours, and every one of them was accepted and then silently
 * applied to planning and billing. The web form now states these same ranges next to each box;
 * these decorators are what actually enforces them, because the mobile app and the importer
 * call this API too.
 *
 * The ranges are deliberately generous — they exist to catch a wrong unit or a stray minus sign,
 * not to second-guess an operator.
 */
class CreateClientConfigDto {
  @IsOptional() @IsObject() importMapping?: Record<string, string>;
  @IsOptional() @IsArray() workingDays?: number[];
  /**
   * Serviceability radius in km. Below 1 no branch is ever in range; the platform default is 50.
   *
   * The ceiling is 999 because `client_configurations.default_radius` is `numeric(5,2)` — it
   * cannot hold 1000. The decorator used to say 2000, so a value between 1000 and 2000 passed
   * every check the API had and then overflowed in Postgres, which the error boundary correctly
   * redacted into a bare **500 "Internal server error"**. Measured: `defaultRadius: 999999`
   * answered 500, not 400. A bound that is wider than the column is not a bound.
   */
  @IsOptional() @IsNumber() @Min(1) @Max(999) defaultRadius?: number;
  @IsOptional() @IsObject() slaRules?: Record<string, any>;
  @IsOptional() @IsString() serviceLevel?: string;
  // Hours, so an upper bound of one year. Zero would mean "already breached on creation".
  @IsOptional() @IsNumber() @Min(1) @Max(8760) maxResponseTimeHours?: number;
  // A percentage of the fee. A negative rate would pay a bonus for missing the SLA.
  @IsOptional() @IsNumber() @Min(0) @Max(100) penaltyRate?: number;
  @IsOptional() @IsObject() serviceHours?: Record<string, any>;
  // The client rate card that determines what the client is billed — distinct from the
  // assayer's own commercial profile, which determines what the assayer is paid. The gap
  // between them is the margin. These columns exist and FeePolicyService reads them, but
  // nothing could write them, so they stayed NULL and billing fell through to platform
  // defaults on every client.
  // Rupees. A negative fee is a payment to the client; the ceiling only catches a paise/rupee mix-up.
  @IsOptional() @IsNumber() @Min(0) @Max(10_000_000) defaultBaseFee?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) travelFeePerKm?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(2000) freeTravelAllowanceKm?: number;
}

/**
 * The same configuration, plus the version the operator was looking at when they decided.
 *
 * Separate from `CreateClientConfigDto` on purpose: creating a client has nothing to be stale
 * about, and a field that is accepted-and-ignored on one route is how an API teaches callers to
 * send something meaningless. Required on update — the service refuses without it; see
 * `pricing-version.ts` for why an absent version is not the same as "no opinion".
 */
class UpdateClientConfigDto extends CreateClientConfigDto {
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

class CreateClientRequestDto implements CreateClientDto {
  // Lengths mirror the columns (see the clients table): over-long input used to reach Postgres and
  // come back as a 500 telling the operator something had gone wrong "on our side" and to try
  // again — advice that could never work, since the fix was to shorten the field.
  /**
   * Optional. Blank means "allocate the next free one" — see `ClientService.allocateClientCode()`,
   * which is the same rule branches, projects and assayers already follow.
   *
   * Still declared because every existing caller (the mobile app, the seed, imports) supplies
   * one, and a supplied code is always honoured exactly as typed.
   */
  @IsOptional() @IsString() @TrimmedString() @MaxLength(50) clientCode?: string;
  @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) displayName: string;
  @IsOptional() @IsString() @MaxLength(500) @IsHttpUrl() website?: string;
  @IsOptional() @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @IsString() @MaxLength(50) clientType?: string;
  @IsOptional() @IsString() @MaxLength(100) registrationNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) @IsGstinOrPanFormat() taxId?: string;
  @IsOptional() @IsString() @MaxLength(200) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(255) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(20) @IsIndianMobile() contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(50) priority?: string;
  // A negative budget is not a budget. It was stored verbatim and rendered as "₹-5000.00".
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsArray() preferredAssayers?: string[];
  @IsOptional() @IsArray() restrictedAssayers?: string[];
  @IsOptional() @IsObject() planningPreferences?: Record<string, any>;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => CreateClientConfigDto) configuration?: CreateClientConfigDto;
}

class UpdateClientRequestDto implements UpdateClientDto {
  // Same rules as create — an edit must not be able to write what create refuses.
  @IsOptional() @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) displayName?: string;
  @IsOptional() @IsString() @MaxLength(500) @IsHttpUrl() website?: string;
  @IsOptional() @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @IsString() @MaxLength(50) clientType?: string;
  @IsOptional() @IsString() @MaxLength(100) registrationNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) @IsGstinOrPanFormat() taxId?: string;
  @IsOptional() @IsString() @MaxLength(200) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(255) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(20) @IsIndianMobile() contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(50) priority?: string;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsArray() preferredAssayers?: string[];
  @IsOptional() @IsArray() restrictedAssayers?: string[];
  @IsOptional() @IsObject() planningPreferences?: Record<string, any>;
  /**
   * `@ValidateNested()` + `@Type()` are what make the bounds above real.
   *
   * This was `@IsOptional() @IsObject()` alone on both DTOs, and class-validator does not descend
   * into a plain object — so every `@Min`/`@Max` in `CreateClientConfigDto` was decoration only,
   * despite that class's own docblock saying "these decorators are what actually enforces them".
   * Measured before the fix, against the live API: `configuration: { travelFeePerKm: -5 }`
   * answered **200** and stored −5.00 — a travel allowance that pays the client per kilometre —
   * and `configuration: { madeUpField: 1 }` answered 200 while `forbidNonWhitelisted` was on.
   */
  @IsOptional() @IsObject() @ValidateNested() @Type(() => UpdateClientConfigDto) configuration?: UpdateClientConfigDto;
}

class CreateContactRequestDto implements CreateContactDto {
  @IsString() @IsNotEmpty() name: string;
  @IsEmail() email: string;
  @IsString() @IsNotEmpty() phone: string;
  @IsString() @IsNotEmpty() designation: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class UpdateContactRequestDto implements UpdateContactDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() designation?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsBoolean() isPrimary?: boolean;
  @IsOptional() @IsString() notes?: string;
}

class CreateContractRequestDto implements CreateContractDto {
  @IsString() @IsNotEmpty() contractNumber: string;
  @IsString() @IsNotEmpty() title: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() signedDate?: string;
  @IsString() @IsNotEmpty() effectiveFrom: string;
  @IsOptional() @IsString() effectiveTo?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsObject() terms?: Record<string, any>;
  @IsOptional() @IsString() documentUrl?: string;
}

export class UpdateContractRequestDto implements UpdateContractDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() signedDate?: string;
  @IsOptional() @IsString() effectiveFrom?: string;
  @IsOptional() @IsString() effectiveTo?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() currency?: string;
  // Was @IsString(): the real column is the ContractStatus enum ContractsPanel.tsx displays
  // (DRAFT/ACTIVE/EXPIRED/TERMINATED/RENEWED). There is no edit-contract UI today — the panel
  // only adds and deletes — so no working flow sends this field at all; this only closes the
  // gap for a direct/malformed API call.
  @IsOptional() @IsEnum(ContractStatus) status?: string;
  @IsOptional() @IsObject() terms?: Record<string, any>;
  @IsOptional() @IsString() documentUrl?: string;
}

class UpdateBillingRequestDto implements UpdateBillingDto {
  @IsOptional() @IsString() paymentTerms?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() taxIdentifier?: string;
  @IsOptional() @IsString() invoiceCycle?: string;
  @IsOptional() @IsString() billingAddress?: string;
  @IsOptional() @IsString() bankAccount?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() ifscCode?: string;
  @IsOptional() @IsString() notes?: string;
  /**
   * Percentages, so 0–100 — the same "bounds, not just types" rule the configuration DTO above
   * states. These were bare `@IsNumber()`, so a stray minus sign or a rate typed in basis points
   * was accepted and then applied to every client line booked afterwards.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) gstRate?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) tdsRate?: number;
  /**
   * The version of the profile this edit was decided against — required when a profile already
   * exists, refused as stale when it is not the committed one. See `pricing-version.ts`.
   */
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}

class LifecycleTransitionDto {
  @IsEnum(ClientLifecycleStatus)
  status: string;

  @IsOptional() @IsString()
  reason?: string;
}

class BulkLifecycleTransitionDto {
  @IsArray() @IsNotEmpty()
  @IsUUID('4', { each: true })
  ids: string[];

  @IsEnum(ClientLifecycleStatus)
  status: string;

  @IsOptional() @IsString()
  reason?: string;
}

@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
// Internal book: staff only. Individual routes narrow this further.
@Roles(...STAFF_ROLES)
@Controller('clients')
export class ClientController {
  constructor(
    private readonly clientService: ClientService,
    private readonly qualificationScores: QualificationScoreService,
  ) {}

  /**
   * ADMIN/OPERATIONS only, like the assayer dossier: each row's gap text names background-check
   * standing and unverified paperwork — exactly what the field-visibility rules keep from the
   * planning-only roles.
   *
   * Region-scoped (staged) by each candidate assayer's OWN region — see
   * `ClientService.filterQualifiedAssayersByRegion` for why the client id this route is keyed on
   * has no region of its own to scope by, and why the assayers do.
   */
  @Get(':clientId/qualified-assayers')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('assayer:view:organization')
  @ApiOperation({ summary: 'Every plannable assayer scored for this partner, best first' })
  async qualifiedAssayers(
    @Param('clientId', ParseUUIDPipe) clientId: string,
    @Query('minScore') minScore?: string,
    @GlobalScopeFilter() scope?: GlobalScope,
  ) {
    const min = Number(minScore);
    const data = await this.qualificationScores.qualifiedAssayersForClient(
      clientId,
      Number.isFinite(min) ? min : 0,
    );
    const scoped = await this.clientService.filterQualifiedAssayersByRegion(data, scope);
    return { success: true, data: scoped };
  }

  // -----------------------------------------------------------------------
  // Profile
  // -----------------------------------------------------------------------

  @Post()
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:create:organization')
  @ApiOperation({ summary: 'Create a new client profile' })
  async create(@Body() dto: CreateClientRequestDto, @Req() req: any) {
    const client = await this.clientService.create(dto, req.user.id, req.user.organizationId);
    return { success: true, data: client };
  }

  /**
   * Not region-scoped, deliberately. `ClientEntity` has no `region` column — a client is a
   * national account whose branches (not the client row) carry a region; see
   * `branch.controller.ts findAll`, which filters branches by `clientId`, `zoneId` AND `region`
   * as independent siblings, not a nested `client.region`. There is nothing resolvable here to
   * filter by without inventing a "client's primary region" concept the schema doesn't have.
   */
  @Get()
  @ApiOperation({ summary: 'List all active client profiles' })
  // `page` reached `clientService.findAll`'s `.skip((page - 1) * limit)` unguarded: `?page=0`,
  // `?page=-1` and `?page=abc` each produced a negative or NaN `skip`, rejected by Postgres/
  // TypeORM before the query ran — an unhandled 500 rather than just serving page one. Same gap
  // already found and fixed the same way across several other list endpoints.
  async findAll(
    @Query('page', new ParsePagePipe()) page: number,
    // `limit` reached `clientService.findAll`'s `.take(limit)` with no ceiling at all:
    // `?limit=5000000` was accepted and echoed back in meta, and `?limit=-5` reached Postgres
    // as a negative and 500'd. ParseLimitPipe keeps the existing default of 20.
    @Query('limit', new ParseLimitPipe({ default: 20, max: 200 })) limit: number,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('clientType') clientType?: string,
    @Query('priority') priority?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'ASC' | 'DESC',
  ) {
    const { clients, total } = await this.clientService.findAll(page, limit, {
      search,
      status,
      clientType,
      priority,
      sortBy,
      sortOrder,
    });
    return {
      success: true,
      data: clients,
      meta: {
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit),
          hasNext: page * limit < total,
          hasPrevious: page > 1,
        },
      },
    };
  }

  /** Not region-scoped: same reasoning as `findAll` above — a client has no region of its own. */
  @Get(':id')
  @ApiOperation({ summary: 'Get client profile with contacts, contracts, and billing' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const client = await this.clientService.findOne(id);
    return { success: true, data: client };
  }

  @Put(':id')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Update client profile and configuration' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClientRequestDto, @Req() req: any) {
    const client = await this.clientService.update(id, dto, req.user.id);
    return { success: true, data: client };
  }

  @Delete(':id')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('client:delete:organization')
  @ApiOperation({ summary: 'Soft delete client profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.clientService.remove(id, req.user.id);
    return { success: true, data: { message: 'Client deleted successfully' } };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  @Patch('bulk/lifecycle')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Migrate a batch of clients forward to a target lifecycle stage' })
  async bulkTransitionLifecycle(
    @Body() dto: BulkLifecycleTransitionDto,
    @Req() req: any,
  ) {
    const result = await this.clientService.bulkTransitionLifecycle(dto.ids, dto.status, req.user.id, dto.reason);
    return { success: true, data: result };
  }

  @Patch(':id/lifecycle')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Transition client lifecycle status' })
  async transitionLifecycle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LifecycleTransitionDto,
    @Req() req: any,
  ) {
    const client = await this.clientService.transitionLifecycle(id, dto.status, req.user.id, dto.reason);
    return { success: true, data: client };
  }

  // -----------------------------------------------------------------------
  // Contacts
  // -----------------------------------------------------------------------

  /**
   * Not region-scoped: `ClientContactEntity` has no `region`/`branchId` column — a contact is
   * tied only to the (regionless) client, never to a branch.
   */
  @Get(':id/contacts')
  @ApiOperation({ summary: 'List client contacts' })
  async findContacts(@Param('id', ParseUUIDPipe) id: string) {
    const contacts = await this.clientService.findContacts(id);
    return { success: true, data: contacts };
  }

  @Post(':id/contacts')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:create:organization')
  @ApiOperation({ summary: 'Add contact to client' })
  async addContact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContactRequestDto,
    @Req() req: any,
  ) {
    const contact = await this.clientService.addContact(id, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Put(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Update client contact' })
  async updateContact(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateContactRequestDto,
    @Req() req: any,
  ) {
    const contact = await this.clientService.updateContact(contactId, dto, req.user.id);
    return { success: true, data: contact };
  }

  @Delete(':id/contacts/:contactId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('client:delete:organization')
  @ApiOperation({ summary: 'Remove client contact' })
  async removeContact(
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Req() req: any,
  ) {
    await this.clientService.removeContact(contactId, req.user.id);
    return { success: true, data: { message: 'Contact removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Contracts
  // -----------------------------------------------------------------------

  /**
   * Not region-scoped: `ClientContractEntity` has no `region` or `branchId` column (checked
   * directly — contracts carry `contractNumber`, `effectiveFrom/To`, `value`, `terms`, etc., but
   * nothing branch- or region-shaped). A contract is a commercial agreement with the client as a
   * whole, not with one of its branches, so there is no region to resolve.
   */
  @Get(':id/contracts')
  @ApiOperation({ summary: 'List client contracts' })
  async findContracts(@Param('id', ParseUUIDPipe) id: string) {
    const contracts = await this.clientService.findContracts(id);
    return { success: true, data: contracts };
  }

  @Post(':id/contracts')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:create:organization')
  @ApiOperation({ summary: 'Add contract to client' })
  async addContract(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateContractRequestDto,
    @Req() req: any,
  ) {
    const contract = await this.clientService.addContract(id, dto, req.user.id);
    return { success: true, data: contract };
  }

  @Put(':id/contracts/:contractId')
  @Roles(SystemRole.ADMIN, SystemRole.OPERATIONS)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Update client contract' })
  async updateContract(
    @Param('contractId', ParseUUIDPipe) contractId: string,
    @Body() dto: UpdateContractRequestDto,
    @Req() req: any,
  ) {
    const contract = await this.clientService.updateContract(contractId, dto, req.user.id);
    return { success: true, data: contract };
  }

  @Delete(':id/contracts/:contractId')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('client:delete:organization')
  @ApiOperation({ summary: 'Soft delete client contract' })
  async removeContract(
    @Param('contractId', ParseUUIDPipe) contractId: string,
    @Req() req: any,
  ) {
    await this.clientService.removeContract(contractId, req.user.id);
    return { success: true, data: { message: 'Contract removed successfully' } };
  }

  // -----------------------------------------------------------------------
  // Billing
  // -----------------------------------------------------------------------

  /**
   * Not region-scoped: `ClientBillingEntity` has no `region` column — one billing profile per
   * client (payment terms, GST/TDS rates, bank details), with no per-branch override to resolve
   * a region from.
   */
  @Get(':id/billing')
  @ApiOperation({ summary: 'Get client billing information' })
  async findBilling(@Param('id', ParseUUIDPipe) id: string) {
    const billing = await this.clientService.findBilling(id);
    return { success: true, data: billing };
  }

  @Put(':id/billing')
  @Roles(SystemRole.ADMIN)
  @RequirePermissions('client:edit:organization')
  @ApiOperation({ summary: 'Create or update client billing information' })
  async upsertBilling(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBillingRequestDto,
    @Req() req: any,
  ) {
    const billing = await this.clientService.upsertBilling(id, dto, req.user.id);
    return { success: true, data: billing };
  }
}
