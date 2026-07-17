/**
 * FAPOMS — Branch Service
 *
 * Manages the bank branch lifecycle and Excel list imports (Part 2 §4, Part 5 §4).
 * Uses PostGIS for geolocation indexing and coordinate-proximity calculations.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as XLSX from 'xlsx';

import { BranchEntity } from './branch.entity';
import { ClientService } from '../client/client.service';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

export interface CreateBranchDto {
  branchCode: string;
  solId?: string;
  name: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode?: string;
  latitude?: number;
  longitude?: number;
  clientId?: string;
}

@Injectable()
export class BranchService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(GeoStateEntity)
    private readonly stateRepository: Repository<GeoStateEntity>,
    @InjectRepository(GeoDistrictEntity)
    private readonly districtRepository: Repository<GeoDistrictEntity>,
    @InjectRepository(GeoCityEntity)
    private readonly cityRepository: Repository<GeoCityEntity>,
    private readonly clientService: ClientService,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateBranchDto, userId: string): Promise<BranchEntity> {
    // Validate geography against master reference tables (Part 7 §10)
    await this.validateGeography(dto.state, dto.district, dto.city);

    // Build PostGIS spatial location point if coordinates are provided
    let location = null;
    if (dto.latitude && dto.longitude) {
      location = {
        type: 'Point',
        coordinates: [dto.longitude, dto.latitude], // GeoJSON order: [longitude, latitude]
      };
    }

    const branch = this.branchRepository.create({
      branchCode: dto.branchCode,
      solId: dto.solId ?? null,
      name: dto.name,
      address: dto.address,
      state: dto.state,
      district: dto.district,
      city: dto.city,
      pincode: dto.pincode ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
      location,
      clientId: dto.clientId ?? null,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.branchRepository.save(branch);

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'BRANCH_CREATED',
      entityType: 'BRANCH',
      entityId: saved.id,
      userId,
      remarks: `Created branch ${saved.name} (Code: ${saved.branchCode})`,
    });

    return saved;
  }

  async findOne(id: string): Promise<BranchEntity> {
    const branch = await this.branchRepository.findOne({ where: { id, isActive: true } });
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found.`);
    }
    return branch;
  }

  async findAll(
    page = 1,
    limit = 20,
    clientId?: string,
  ): Promise<{ branches: BranchEntity[]; total: number }> {
    const query = this.branchRepository.createQueryBuilder('branch')
      .where('branch.is_active = :isActive', { isActive: true });

    if (clientId) {
      query.andWhere('branch.client_id = :clientId', { clientId });
    }

    const [branches, total] = await query
      .orderBy('branch.name', 'ASC')
      .take(limit)
      .skip((page - 1) * limit)
      .getManyAndCount();

    return { branches, total };
  }

  /**
   * Import branches from an Excel buffer.
   * Maps columns dynamically using the client's custom layout mapping config (Part 5 §4).
   */
  async importExcel(
    fileBuffer: Buffer,
    clientId: string,
    userId: string,
  ): Promise<{ importedCount: number; errors: string[] }> {
    // Load Client config
    const client = await this.clientService.findOne(clientId);
    const mapping = client.configuration?.importMapping;

    if (!mapping || Object.keys(mapping).length === 0) {
      throw new BadRequestException('Client import mappings are not configured.');
    }

    // Parse Excel Workbook
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

    const errors: string[] = [];
    let importedCount = 0;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowNum = index + 2; // Excel is 1-indexed and row 1 is header

      try {
        // Map raw row fields to internal schema using client config mapping
        const branchCode = String(row[mapping['branchCode'] || 'Branch Code'] || '').trim();
        const solId = String(row[mapping['solId'] || 'SOL ID'] || '').trim();
        const name = String(row[mapping['name'] || 'Branch Name'] || '').trim();
        const address = String(row[mapping['address'] || 'Address'] || '').trim();
        const state = String(row[mapping['state'] || 'State'] || '').trim();
        const district = String(row[mapping['district'] || 'District'] || '').trim();
        const city = String(row[mapping['city'] || 'City'] || '').trim();
        const pincode = String(row[mapping['pincode'] || 'Pincode'] || '').trim();
        const latitude = parseFloat(row[mapping['latitude'] || 'Latitude']);
        const longitude = parseFloat(row[mapping['longitude'] || 'Longitude']);

        if (!branchCode || !name || !address || !state || !district || !city) {
          errors.push(`Row ${rowNum}: Missing required fields (Code, Name, Address, State, District, City)`);
          continue;
        }

        // Validate geography reference matches (Part 7 §10)
        try {
          await this.validateGeography(state, district, city);
        } catch (geoErr: any) {
          errors.push(`Row ${rowNum}: Geography validation failed - ${geoErr.message}`);
          continue;
        }

        // Check for duplicates
        const existing = await this.branchRepository.findOne({
          where: { branchCode, clientId, isActive: true },
        });

        if (existing) {
          // Update details if already imported (upsert behavior)
          existing.name = name;
          existing.address = address;
          existing.state = state;
          existing.district = district;
          existing.city = city;
          existing.pincode = pincode || null;
          existing.latitude = isNaN(latitude) ? null : latitude;
          existing.longitude = isNaN(longitude) ? null : longitude;
          existing.updatedBy = userId;
          
          if (!isNaN(latitude) && !isNaN(longitude)) {
            existing.location = { type: 'Point', coordinates: [longitude, latitude] };
          }
          await this.branchRepository.save(existing);
        } else {
          // Insert new branch record
          const branch = this.branchRepository.create({
            branchCode,
            solId: solId || null,
            name,
            address,
            state,
            district,
            city,
            pincode: pincode || null,
            latitude: isNaN(latitude) ? null : latitude,
            longitude: isNaN(longitude) ? null : longitude,
            clientId,
            location: (!isNaN(latitude) && !isNaN(longitude)) ? { type: 'Point', coordinates: [longitude, latitude] } : null,
            createdBy: userId,
            updatedBy: userId,
          });
          await this.branchRepository.save(branch);
        }

        importedCount++;
      } catch (err: any) {
        errors.push(`Row ${rowNum}: Unexpected parse error - ${err.message}`);
      }
    }

    if (importedCount > 0) {
      await this.auditService.recordEvent({
        category: EventCategory.OPERATIONAL,
        eventType: 'BRANCHES_BULK_IMPORT',
        entityType: 'CLIENT',
        entityId: clientId,
        userId,
        remarks: `Bulk imported/updated ${importedCount} branches from sheet. Errors logged: ${errors.length}`,
      });
    }

    return { importedCount, errors };
  }

  // -------------------------------------------------------------------------
  // Private helper: Validate State/District/City against Master Reference
  // -------------------------------------------------------------------------
  private async validateGeography(state: string, district: string, city: string): Promise<void> {
    const stateEntity = await this.stateRepository.findOne({ where: { name: state } });
    if (!stateEntity) {
      throw new Error(`State '${state}' not found in master reference data.`);
    }

    const districtEntity = await this.districtRepository.findOne({ 
      where: { name: district, stateId: stateEntity.id } 
    });
    if (!districtEntity) {
      throw new Error(`District '${district}' not found under state '${state}' in master reference data.`);
    }

    const cityEntity = await this.cityRepository.findOne({ 
      where: { name: city, districtId: districtEntity.id } 
    });
    if (!cityEntity) {
      throw new Error(`City '${city}' not found under district '${district}' in master reference data.`);
    }
  }
}
