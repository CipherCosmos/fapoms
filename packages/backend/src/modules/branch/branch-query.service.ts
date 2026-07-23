import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BranchEntity } from './branch.entity';

@Injectable()
export class BranchQueryService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
  ) {}

  async findOne(id: string): Promise<BranchEntity> {
    const branch = await this.branchRepository.findOne({
      where: { id, isActive: true },
      relations: ['contacts', 'documents'],
    });
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found.`);
    }
    return branch;
  }

  async findAll(
    page = 1,
    limit = 50,
    clientId?: string,
  ): Promise<{ branches: BranchEntity[]; total: number }> {
    const query = this.branchRepository.createQueryBuilder('branch')
      .leftJoinAndSelect('branch.contacts', 'contacts')
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

  async findOneByCode(branchCode: string): Promise<BranchEntity | null> {
    return this.branchRepository.findOne({ where: { branchCode, isActive: true } });
  }
}
