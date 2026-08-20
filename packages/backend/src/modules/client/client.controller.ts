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
  IsString, IsNotEmpty, IsOptional, IsObject, IsArray, IsNumber, IsEmail, IsBoolean, IsEnum, Min, Max, IsUUID, MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Trim before validating, so a field of spaces fails `@IsNotEmpty` like the empty string it is.
 *
 * `"   "` satisfies both the browser's `required` attribute and class-validator's non-empty check,
 * which let a client be created with a blank code and name. It rendered as an empty row in the
 * clients list and, worse, as a selectable "( )" entry in every downstream client picker.
 */
const TrimmedString = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
import { ClientService, CreateClientDto, UpdateClientDto, CreateContactDto, UpdateContactDto, CreateContractDto, UpdateContractDto, UpdateBillingDto } from './client.service';
import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { SystemRole, ClientLifecycleStatus } from '@fapoms/shared';

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
  // Serviceability radius in km. Below 1 no branch is ever in range; the platform default is 50.
  @IsOptional() @IsNumber() @Min(1) @Max(2000) defaultRadius?: number;
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
  @IsOptional() @IsString() @MaxLength(500) website?: string;
  @IsOptional() @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @IsString() @MaxLength(50) clientType?: string;
  @IsOptional() @IsString() @MaxLength(100) registrationNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) taxId?: string;
  @IsOptional() @IsString() @MaxLength(200) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(255) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(20) contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(50) priority?: string;
  // A negative budget is not a budget. It was stored verbatim and rendered as "₹-5000.00".
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsArray() preferredAssayers?: string[];
  @IsOptional() @IsArray() restrictedAssayers?: string[];
  @IsOptional() @IsObject() planningPreferences?: Record<string, any>;
  @IsOptional() @IsObject() configuration?: CreateClientConfigDto;
}

class UpdateClientRequestDto implements UpdateClientDto {
  // Same rules as create — an edit must not be able to write what create refuses.
  @IsOptional() @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) name?: string;
  @IsOptional() @IsString() @TrimmedString() @IsNotEmpty() @MaxLength(255) displayName?: string;
  @IsOptional() @IsString() @MaxLength(500) website?: string;
  @IsOptional() @IsString() @MaxLength(100) industry?: string;
  @IsOptional() @IsString() @MaxLength(50) clientType?: string;
  @IsOptional() @IsString() @MaxLength(100) registrationNumber?: string;
  @IsOptional() @IsString() @MaxLength(100) taxId?: string;
  @IsOptional() @IsString() @MaxLength(200) contactPerson?: string;
  @IsOptional() @IsString() @MaxLength(255) contactEmail?: string;
  @IsOptional() @IsString() @MaxLength(20) contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() @MaxLength(50) priority?: string;
  @IsOptional() @IsNumber() @Min(0) budget?: number;
  @IsOptional() @IsArray() preferredAssayers?: string[];
  @IsOptional() @IsArray() restrictedAssayers?: string[];
  @IsOptional() @IsObject() planningPreferences?: Record<string, any>;
  @IsOptional() @IsObject() configuration?: CreateClientConfigDto;
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

class UpdateContractRequestDto implements UpdateContractDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() signedDate?: string;
  @IsOptional() @IsString() effectiveFrom?: string;
  @IsOptional() @IsString() effectiveTo?: string;
  @IsOptional() @IsNumber() value?: number;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() status?: string;
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
  @IsOptional() @IsNumber() gstRate?: number;
  @IsOptional() @IsNumber() tdsRate?: number;
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
  constructor(private readonly clientService: ClientService) {}

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

  @Get()
  @ApiOperation({ summary: 'List all active client profiles' })
  async findAll(
    @Query('page') page = 1,
    @Query('limit') limit = 20,
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
