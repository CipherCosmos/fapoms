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
  IsString, IsNotEmpty, IsOptional, IsObject, IsArray, IsNumber, IsEmail, IsBoolean, IsEnum, Min,
} from 'class-validator';
import { ClientService, CreateClientDto, UpdateClientDto, CreateContactDto, UpdateContactDto, CreateContractDto, UpdateContractDto, UpdateBillingDto } from './client.service';
import { JwtAuthGuard, RolesGuard, Roles } from '../auth/guards';
import { SystemRole, ClientLifecycleStatus } from '@fapoms/shared';

class CreateClientConfigDto {
  @IsOptional() @IsObject() importMapping?: Record<string, string>;
  @IsOptional() @IsArray() workingDays?: number[];
  @IsOptional() @IsNumber() defaultRadius?: number;
  @IsOptional() @IsObject() slaRules?: Record<string, any>;
  @IsOptional() @IsString() serviceLevel?: string;
  @IsOptional() @IsNumber() maxResponseTimeHours?: number;
  @IsOptional() @IsNumber() penaltyRate?: number;
  @IsOptional() @IsObject() serviceHours?: Record<string, any>;
}

class CreateClientRequestDto implements CreateClientDto {
  @IsString() @IsNotEmpty() clientCode: string;
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() displayName: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() clientType?: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsString() contactPerson?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsNumber() budget?: number;
  @IsOptional() @IsArray() preferredAssayers?: string[];
  @IsOptional() @IsArray() restrictedAssayers?: string[];
  @IsOptional() @IsObject() planningPreferences?: Record<string, any>;
  @IsOptional() @IsObject() configuration?: CreateClientConfigDto;
}

class UpdateClientRequestDto implements UpdateClientDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() industry?: string;
  @IsOptional() @IsString() clientType?: string;
  @IsOptional() @IsString() registrationNumber?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() @IsString() contactPerson?: string;
  @IsOptional() @IsString() contactEmail?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsNumber() budget?: number;
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
}

class LifecycleTransitionDto {
  @IsEnum(ClientLifecycleStatus)
  status: string;

  @IsOptional() @IsString()
  reason?: string;
}

@ApiTags('Clients')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('clients')
export class ClientController {
  constructor(private readonly clientService: ClientService) {}

  // -----------------------------------------------------------------------
  // Profile
  // -----------------------------------------------------------------------

  @Post()
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Create a new client profile' })
  async create(@Body() dto: CreateClientRequestDto, @Req() req: any) {
    const client = await this.clientService.create(dto, req.user.id);
    return { success: true, data: client };
  }

  @Get()
  @ApiOperation({ summary: 'List all active client profiles' })
  async findAll(@Query('page') page = 1, @Query('limit') limit = 20) {
    const { clients, total } = await this.clientService.findAll(page, limit);
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
  @ApiOperation({ summary: 'Update client profile and configuration' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClientRequestDto, @Req() req: any) {
    const client = await this.clientService.update(id, dto, req.user.id);
    return { success: true, data: client };
  }

  @Delete(':id')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
  @ApiOperation({ summary: 'Soft delete client profile' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    await this.clientService.remove(id, req.user.id);
    return { success: true, data: { message: 'Client deleted successfully' } };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  @Patch(':id/lifecycle')
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR, SystemRole.OPERATIONS_MANAGER)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
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
  @Roles(SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR)
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
