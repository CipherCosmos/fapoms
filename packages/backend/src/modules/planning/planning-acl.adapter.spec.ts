import { Test, TestingModule } from '@nestjs/testing';
import { PlanningAntiCorruptionLayer } from './planning-acl.adapter';
import { BranchEntity } from '../branch/branch.entity';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { ProjectBranchEntity } from '../project/project-branch.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AssayerService } from '../assayer/assayer.service';

describe('PlanningAntiCorruptionLayer', () => {
  let acl: PlanningAntiCorruptionLayer;

  const mockAssayerService = {
    hydrateWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    hydrateAllWorkforceAttributes: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue({ assayers: [], total: 0 }),
    findOne: jest.fn().mockResolvedValue({ id: 'asr-1', skills: [], certifications: [], languages: [], specializations: [] }),
  };

  const mockBranchRepo = {};
  const mockAssayerRepo = {
    find: jest.fn().mockResolvedValue([
      { id: 'as-1', displayName: 'Vijay Shankar', status: 'ACTIVE', latitude: 19.0, longitude: 72.0, skills: ['Gold'] },
    ]),
  };
  const mockAssignmentRepo = {};
  const mockProjectBranchRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'pb-1',
        branch: { id: 'b-1', branchCode: 'B01', name: 'Pune Central', latitude: 18.5, longitude: 73.8, city: 'Pune', state: 'MH', requiredCompetencies: ['Gold'] },
      },
    ]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlanningAntiCorruptionLayer,
        { provide: getRepositoryToken(BranchEntity), useValue: mockBranchRepo },
        { provide: getRepositoryToken(AssayerEntity), useValue: mockAssayerRepo },
        { provide: getRepositoryToken(AssignmentEntity), useValue: mockAssignmentRepo },
        { provide: getRepositoryToken(ProjectBranchEntity), useValue: mockProjectBranchRepo },
        { provide: AssayerService, useValue: mockAssayerService },
      ],
    }).compile();

    acl = module.get<PlanningAntiCorruptionLayer>(PlanningAntiCorruptionLayer);
  });

  it('should map ProjectBranchEntity into PlanningBranch domains', async () => {
    const branches = await acl.getBranchesForPlanning('p-1');
    expect(branches.length).toBe(1);
    expect(branches[0].branchCode).toBe('B01');
    expect(branches[0].location.latitude).toBe(18.5);
    expect(branches[0].requiredSkills.has('Gold')).toBe(true);
  });

  it('should map AssayerEntity into PlanningAssayer domains', async () => {
    const assayers = await acl.getAvailableAssayers(new Date());
    expect(assayers.length).toBe(1);
    expect(assayers[0].displayName).toBe('Vijay Shankar');
    expect(assayers[0].location.latitude).toBe(19.0);
  });
});
