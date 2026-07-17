/**
 * FAPOMS — Planning Service
 *
 * Implements candidate recommendations using PostGIS proximity search (Part 3 Module 5, Part 7 §6).
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

export interface AssayerRecommendation {
  id: string;
  assayerCode: string;
  displayName: string;
  phone: string;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
}

@Injectable()
export class PlanningService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
  ) {}

  async getRecommendedCandidates(branchId: string): Promise<AssayerRecommendation[]> {
    const branch = await this.branchRepository.findOne({
      where: { id: branchId, isActive: true },
    });

    if (!branch) {
      throw new NotFoundException(`Branch ${branchId} not found.`);
    }

    // Check if coordinates exist
    if (branch.latitude && branch.longitude) {
      // Execute raw query using PostGIS ST_DistanceSphere for spherical distance
      // SRID 4326 (WGS 84 coordinates point: longitude, latitude)
      const rawResults = await this.assayerRepository.createQueryBuilder('assayer')
        .select([
          'assayer.id AS id',
          'assayer.assayer_code AS "assayerCode"',
          'assayer.display_name AS "displayName"',
          'assayer.phone AS phone',
          'assayer.email AS email',
          'assayer.status AS status',
          'assayer.state AS state',
          'assayer.district AS district',
          'assayer.city AS city',
          `ST_DistanceSphere(assayer.location, ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)) / 1000 AS "distanceKm"`
        ])
        .where('assayer.is_active = :isActive', { isActive: true })
        .andWhere('assayer.status = :status', { status: 'ACTIVE' })
        .setParameter('longitude', branch.longitude)
        .setParameter('latitude', branch.latitude)
        .orderBy('"distanceKm"', 'ASC')
        .getRawMany();

      return rawResults.map(r => ({
        ...r,
        distanceKm: r.distanceKm ? parseFloat(parseFloat(r.distanceKm).toFixed(2)) : null
      }));
    }

    // fallback: find assayers by matching State and District if no coordinates (Part 7 §6 fallback)
    const fallbackResults = await this.assayerRepository.find({
      where: {
        state: branch.state,
        district: branch.district,
        status: 'ACTIVE',
        isActive: true,
      },
      order: { displayName: 'ASC' },
    });

    return fallbackResults.map(a => ({
      id: a.id,
      assayerCode: a.assayerCode,
      displayName: a.displayName,
      phone: a.phone,
      email: a.email,
      status: a.status,
      state: a.state,
      district: a.district,
      city: a.city,
      distanceKm: null, // no coordinates fallback
    }));
  }
}
