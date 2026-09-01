import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SearchService } from './search.service';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { ProjectEntity } from '../project/project.entity';
import { ClientEntity } from '../client/client.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { SystemRole, Region } from '@fapoms/shared';

/**
 * Global search reads across every table at once, which makes it the one endpoint where a
 * missing guard costs everything at the same time.
 *
 * It shipped with `@UseGuards(JwtAuthGuard)` alone. No `RolesGuard`, so the deny-by-default
 * rule that governs every other controller never ran; no `@Roles`, so any authenticated
 * principal reached it — a field assayer's handset token included. And no scope, so it
 * answered with the national index while the branch, project and assignment lists beside it
 * were carefully filtered by region. It was the way around every boundary the rest of the
 * app enforces.
 */
describe('global search access', () => {
  describe('the door', () => {
    const source = readFileSync(join(__dirname, 'search.controller.ts'), 'utf8');

    it('runs the guard that denies by default', () => {
      // Without RolesGuard in the chain, `@Roles` is inert and an absent `@Roles` is not a
      // refusal — which is exactly how this route came to be open to everyone.
      expect(source).toMatch(/@UseGuards\([^)]*RolesGuard/);
    });

    it('names an audience, so a principal outside it is refused', () => {
      expect(source).toMatch(/@Roles\(\.\.\.STAFF_ROLES\)/);
    });

    it('takes the caller boundary, not just a query string', () => {
      expect(source).toContain('@GlobalScopeFilter()');
    });
  });

  describe('the results', () => {
    let service: SearchService;
    const find = jest.fn(async () => []);
    const qb: any = {
      where: jest.fn(() => qb), andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb), take: jest.fn(() => qb), getMany: jest.fn(async () => []),
    };

    /** Every `where` object handed to a repository, flattened. */
    const wheresPassed = () => find.mock.calls.flatMap((c: any) => c[0]?.where ?? []);

    beforeEach(async () => {
      find.mockClear();
      for (const k of ['where', 'andWhere', 'orderBy', 'take']) qb[k].mockClear();
      const repo = { find, createQueryBuilder: () => qb };
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SearchService,
          ...[BranchEntity, AssayerEntity, ProjectEntity, ClientEntity, AssignmentEntity]
            .map((e) => ({ provide: getRepositoryToken(e), useValue: repo })),
        ],
      }).compile();
      service = module.get(SearchService);
    });

    it('narrows every branch and assayer clause to the caller regions', async () => {
      await service.searchAll('pune', { regions: [Region.WEST] }, [SystemRole.OPERATIONS]);

      const clauses = wheresPassed();
      expect(clauses.length).toBeGreaterThan(0);

      /**
       * A `find` with an array of wheres ORs them, so one unscoped clause leaks the whole
       * table however carefully the others are written. Every clause that matches a *branch*
       * or an *assayer* — the two things region actually applies to — must carry it.
       *
       * Clients and assignments are deliberately not region-filtered: a client is not
       * territorial and their own list endpoints do not narrow them either, so doing it here
       * would make search answer differently from the page it feeds.
       */
      const geographic = clauses.filter(
        (w: any) => 'solId' in w || 'assayerCode' in w || 'city' in w || 'address' in w
          || 'firstName' in w || 'lastName' in w,
      );
      expect(geographic.length).toBeGreaterThan(0);
      for (const w of geographic) {
        expect(w).toHaveProperty('region');
      }
    });

    it('asks for everything when the caller holds every region', async () => {
      await service.searchAll('pune', { regions: null }, [SystemRole.ADMIN]);

      for (const w of wheresPassed()) {
        expect(w).not.toHaveProperty('region');
      }
    });

    it('restricts projects to those with a branch the caller can see', async () => {
      await service.searchAll('audit', { regions: [Region.WEST] }, [SystemRole.OPERATIONS]);

      const sql = qb.andWhere.mock.calls.map((c: any) => String(c[0])).join(' | ');
      expect(sql).toContain('project_branches');
      expect(sql).toContain('b.region IN');
    });
  });
});
