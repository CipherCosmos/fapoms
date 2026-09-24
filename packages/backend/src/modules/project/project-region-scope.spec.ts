import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * GET / PUT / transition on `/projects/:id` for a region-assigned caller.
 *
 * All three took a bare id and no scope, so an EAST-assigned operator could read, edit and move
 * the lifecycle of a project that sits entirely in another region.
 *
 *  - GET is readable exactly when `GET /projects` would list it (≥1 active branch in the
 *    caller's regions) — the same `findAll` predicate, so list and detail cannot disagree.
 *  - PUT and transition are whole-project writes and take `assertProjectInScope`: refused if the
 *    project reaches ANY branch outside the caller's regions.
 *
 * The guard here is the REAL RegionGuardService over a fake data source, so the spec pins the
 * refusal itself, not merely that a mock was called.
 */
describe('ProjectController — region ceiling on :id routes', () => {
  const EAST = { regions: ['EAST'] } as any;
  const NATIONAL = { regions: null } as any;

  let branchRegions: string[];
  const dataSource = { query: jest.fn(async () => branchRegions.map((region) => ({ region }))) };
  const settings = { get: jest.fn() };
  const regionGuard = new RegionGuardService(dataSource as any, settings as any);

  const projectService = {
    findOne: jest.fn(async (id: string) => ({ id, name: 'P' })),
    findAll: jest.fn(),
    update: jest.fn(async (id: string) => ({ id, updated: true })),
    transition: jest.fn(async (id: string) => ({ id, moved: true })),
  };
  const controller = new ProjectController(projectService as any, {} as any, regionGuard);
  const req = { user: { id: 'u-1' } };

  beforeEach(() => {
    jest.clearAllMocks();
    branchRegions = ['WEST'];
  });

  describe('GET /projects/:id', () => {
    it('refuses a region-assigned caller when the project has no branch in their regions', async () => {
      projectService.findAll.mockResolvedValue({ projects: [], total: 0 });
      await expect(controller.findOne('p-1', EAST)).rejects.toThrow(ForbiddenException);
      // Only the account's region ceiling — never the header's zone/state filters.
      expect(projectService.findAll).toHaveBeenCalledWith(1, 1, { regions: ['EAST'], projectId: 'p-1' });
    });

    it('allows it when the list would offer it (a national project with an EAST branch)', async () => {
      projectService.findAll.mockResolvedValue({ projects: [{ id: 'p-1' }], total: 1 });
      await expect(controller.findOne('p-1', { ...EAST, zoneId: 'z-9' })).resolves.toEqual({ id: 'p-1', name: 'P' });
      expect(projectService.findAll).toHaveBeenCalledWith(1, 1, { regions: ['EAST'], projectId: 'p-1' });
    });

    it('does not look anything up for an unrestricted caller', async () => {
      await expect(controller.findOne('p-1', NATIONAL)).resolves.toBeDefined();
      await expect(controller.findOne('p-1')).resolves.toBeDefined();
      expect(projectService.findAll).not.toHaveBeenCalled();
    });

    it('a missing project is still a 404, not a 403', async () => {
      projectService.findOne.mockRejectedValueOnce(new NotFoundException());
      await expect(controller.findOne('p-x', EAST)).rejects.toThrow(NotFoundException);
    });
  });

  describe.each([
    ['PUT /projects/:id', () => controller.update('p-1', {} as any, req, EAST), () => projectService.update],
    ['POST /projects/:id/transition', () => controller.transition('p-1', { targetStatus: 'ACTIVE' } as any, req, EAST), () => projectService.transition],
  ])('%s', (_route, call, svc) => {
    it('refuses a project wholly outside the caller’s regions, and writes nothing', async () => {
      branchRegions = ['WEST'];
      await expect(call()).rejects.toThrow(ForbiddenException);
      expect(svc()).not.toHaveBeenCalled();
    });

    it('refuses a project that reaches ANY branch outside the caller’s regions', async () => {
      branchRegions = ['EAST', 'WEST'];
      await expect(call()).rejects.toThrow(ForbiddenException);
      expect(svc()).not.toHaveBeenCalled();
    });

    it('allows a project entirely inside the caller’s regions', async () => {
      branchRegions = ['EAST'];
      await expect(call()).resolves.toBeDefined();
      expect(svc()).toHaveBeenCalled();
    });
  });

  it('PUT and transition are unaffected for an unrestricted caller', async () => {
    await expect(controller.update('p-1', {} as any, req, NATIONAL)).resolves.toBeDefined();
    await expect(controller.transition('p-1', { targetStatus: 'ACTIVE' } as any, req, NATIONAL)).resolves.toBeDefined();
    expect(dataSource.query).not.toHaveBeenCalled();
  });
});
