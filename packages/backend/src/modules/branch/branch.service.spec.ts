import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BranchService } from './branch.service';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { ClientService } from '../client/client.service';
import { ZoneEntity } from '../zone/zone.entity';
import { GeoStateEntity, GeoDistrictEntity, GeoCityEntity } from '../geo/geo.entities';
import { AuditService } from '../../core/audit/audit.service';

describe('BranchService', () => {
  let service: BranchService;

  const mockBranchRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };

  const mockContactRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    update: jest.fn(),
  };

  const mockDocumentRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockZoneRepo = {
    findOne: jest.fn(),
  };

  const mockStateRepo = { findOne: jest.fn() };
  const mockDistrictRepo = { findOne: jest.fn() };
  const mockCityRepo = { findOne: jest.fn() };

  const mockClientService = { findOne: jest.fn() };
  const mockAuditService = { recordEvent: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BranchService,
        { provide: getRepositoryToken(BranchEntity), useValue: mockBranchRepo },
        { provide: getRepositoryToken(BranchContactEntity), useValue: mockContactRepo },
        { provide: getRepositoryToken(BranchDocumentEntity), useValue: mockDocumentRepo },
        { provide: getRepositoryToken(ZoneEntity), useValue: mockZoneRepo },
        { provide: getRepositoryToken(GeoStateEntity), useValue: mockStateRepo },
        { provide: getRepositoryToken(GeoDistrictEntity), useValue: mockDistrictRepo },
        { provide: getRepositoryToken(GeoCityEntity), useValue: mockCityRepo },
        { provide: ClientService, useValue: mockClientService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<BranchService>(BranchService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should throw an error if state validation fails', async () => {
      mockStateRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          {
            branchCode: 'B-1',
            name: 'Branch 1',
            address: 'Add 1',
            state: 'UnknownState',
            district: 'D-1',
            city: 'C-1',
          },
          'user-1',
        ),
      ).rejects.toThrow(/State 'UnknownState' not found/);
    });

    it('should successfully create a branch if geography validation passes', async () => {
      mockStateRepo.findOne.mockResolvedValue({ id: 's-1', name: 'MH' });
      mockDistrictRepo.findOne.mockResolvedValue({ id: 'd-1', name: 'Pune', stateId: 's-1' });
      mockCityRepo.findOne.mockResolvedValue({ id: 'c-1', name: 'Pune City', districtId: 'd-1' });

      const mockCreatedBranch = {
        id: 'b-123',
        branchCode: 'B-1',
        name: 'Pune Branch',
      };
      mockBranchRepo.create.mockReturnValue(mockCreatedBranch);
      mockBranchRepo.save.mockResolvedValue(mockCreatedBranch);

      const result = await service.create(
        {
          branchCode: 'B-1',
          name: 'Pune Branch',
          address: '123 Main St',
          state: 'MH',
          district: 'Pune',
          city: 'Pune City',
        },
        'user-1',
      );

      expect(result.branchCode).toBe('B-1');
      expect(mockBranchRepo.save).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if branch does not exist', async () => {
      mockBranchRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });
});
