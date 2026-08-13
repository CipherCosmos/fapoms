import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BranchEntity } from './branch.entity';
import { GlobalScope } from '../../infrastructure/scope/global-scope';

@Injectable()
export class BranchQueryService {
  constructor(
    @InjectRepository(BranchEntity)
    private readonly branchRepository: Repository<BranchEntity>,
  ) {}

  async findOne(id: string): Promise<BranchEntity> {
    // Filters is_active on the branch and on its soft-deletable contacts/documents. A plain
    // `relations` load would surface soft-deleted children in the detail view.
    const branch = await this.branchRepository
      .createQueryBuilder('branch')
      .leftJoinAndSelect('branch.contacts', 'contacts', 'contacts.isActive = true')
      .leftJoinAndSelect('branch.documents', 'documents', 'documents.isActive = true')
      .where('branch.id = :id', { id })
      .andWhere('branch.isActive = true')
      .getOne();
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found.`);
    }
    return branch;
  }

  /**
   * List branches under the request's global scope.
   *
   * `scope.regions` is the enforced region ceiling from `resolveGlobalScope` — `null` means
   * unrestricted, an array means restrict. It is applied here rather than left to callers so
   * that a caller which forgets about regions cannot accidentally serve an operator branches
   * outside their assignment.
   */
  async findAll(
    page = 1,
    limit = 50,
    scope: Partial<GlobalScope> = {},
  ): Promise<{ branches: BranchEntity[]; total: number }> {
    const { clientId, zoneId, state, regions } = scope;

    const query = this.branchRepository.createQueryBuilder('branch')
      .leftJoinAndSelect('branch.contacts', 'contacts', 'contacts.isActive = true')
      .where('branch.is_active = :isActive', { isActive: true });

    if (clientId) query.andWhere('branch.client_id = :clientId', { clientId });
    if (zoneId) query.andWhere('branch.zone_id = :zoneId', { zoneId });
    if (state) query.andWhere('UPPER(branch.state) = UPPER(:state)', { state });
    if (regions && regions.length > 0) {
      query.andWhere('branch.region IN (:...regions)', { regions });
    }

    const [branches, total] = await query
      .orderBy('branch.name', 'ASC')
      .take(limit)
      .skip((page - 1) * limit)
      .getManyAndCount();

    return { branches, total };
  }

  /**
   * The distinct regions and states that actually have branches, with counts.
   *
   * Drives the header's scope dropdowns. Built from live data rather than from the `Region`
   * enum so the list never offers an operator a region that would return an empty screen,
   * and narrowed to `scope.regions` so a restricted account is not shown the existence of
   * regions it cannot open.
   */
  async scopeFacets(scope: Partial<GlobalScope> = {}): Promise<{
    regions: Array<{ value: string; count: number }>;
    states: Array<{ value: string; region: string | null; count: number }>;
  }> {
    const base = () => {
      const q = this.branchRepository.createQueryBuilder('branch')
        .where('branch.is_active = :isActive', { isActive: true });
      if (scope.clientId) q.andWhere('branch.client_id = :clientId', { clientId: scope.clientId });
      if (scope.regions && scope.regions.length > 0) {
        q.andWhere('branch.region IN (:...regions)', { regions: scope.regions });
      }
      return q;
    };

    const regionRows = await base()
      .select('branch.region', 'value')
      .addSelect('COUNT(*)', 'count')
      .andWhere('branch.region IS NOT NULL')
      .groupBy('branch.region')
      .getRawMany<{ value: string; count: string }>();

    // Case-insensitive grouping — see the matching note in ScopeController.options.
    const stateRows = await base()
      .select('MODE() WITHIN GROUP (ORDER BY branch.state)', 'value')
      .addSelect('MIN(branch.region)', 'region')
      .addSelect('COUNT(*)', 'count')
      .andWhere('branch.state IS NOT NULL')
      .groupBy('UPPER(branch.state)')
      .orderBy('MODE() WITHIN GROUP (ORDER BY branch.state)', 'ASC')
      .getRawMany<{ value: string; region: string | null; count: string }>();

    return {
      regions: regionRows.map((r) => ({ value: r.value, count: Number(r.count) })),
      states: stateRows.map((r) => ({ value: r.value, region: r.region, count: Number(r.count) })),
    };
  }

  /**
   * A branch by its client-supplied code.
   *
   * `clientId` is not optional in practice, it is optional in the signature: branch codes are
   * the *client's* numbering, not ours, and they collide constantly across clients — every bank
   * has a branch "1". Resolving a code without saying whose it is silently returns some other
   * client's branch, and the import path that did exactly that then attached that branch (with
   * its address, coordinates and region) to this client's project. Pass the client whenever the
   * caller knows it.
   */
  async findOneByCode(branchCode: string, clientId?: string | null): Promise<BranchEntity | null> {
    return this.branchRepository.findOne({
      where: { branchCode, isActive: true, ...(clientId ? { clientId } : {}) },
    });
  }
}
