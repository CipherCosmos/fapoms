import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { OrganizationService } from './organization.service';
import { OrganizationEntity } from './organization.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory } from '@fapoms/shared';

describe('OrganizationService', () => {
  let service: OrganizationService;
  let orgRepo: Repository<OrganizationEntity>;

  const mockOrgRepo = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  };

  const mockAuditService = {
    recordEvent: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: getRepositoryToken(OrganizationEntity), useValue: mockOrgRepo },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<OrganizationService>(OrganizationService);
    orgRepo = module.get<Repository<OrganizationEntity>>(getRepositoryToken(OrganizationEntity));
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an organization successfully', async () => {
      mockOrgRepo.findOne.mockResolvedValue(null);
      const dto = { code: 'TEST', name: 'Test Org' };
      const saved = { id: 'org-1', code: 'TEST', name: 'Test Org', createdBy: 'user-1' };
      mockOrgRepo.create.mockReturnValue(saved);
      mockOrgRepo.save.mockResolvedValue(saved);

      const result = await service.create(dto, 'user-1');

      expect(result.code).toBe('TEST');
      expect(mockOrgRepo.save).toHaveBeenCalled();
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_CREATED', entityType: 'ORGANIZATION' }),
      );
    });

    it('should throw ConflictException for duplicate code', async () => {
      mockOrgRepo.findOne.mockResolvedValue({ id: 'existing', code: 'TEST' });

      await expect(service.create({ code: 'TEST', name: 'Test' }, 'user-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('findAll', () => {
    it('should return paginated organizations', async () => {
      const orgs = [{ id: 'org-1', code: 'TEST', name: 'Test Org' }];
      mockOrgRepo.findAndCount.mockResolvedValue([orgs, 1]);

      const result = await service.findAll(1, 20);

      expect(result.organizations).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('findOne', () => {
    it('should return an organization by id', async () => {
      const org = { id: 'org-1', code: 'TEST', name: 'Test Org', isActive: true };
      mockOrgRepo.findOne.mockResolvedValue(org);

      const result = await service.findOne('org-1');

      expect(result.id).toBe('org-1');
    });

    it('should throw NotFoundException if not found', async () => {
      mockOrgRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update organization fields', async () => {
      const existing = { id: 'org-1', code: 'TEST', name: 'Old Name', isActive: true };
      mockOrgRepo.findOne.mockResolvedValue(existing);
      mockOrgRepo.save.mockImplementation((e) => Promise.resolve(e));

      const result = await service.update('org-1', { name: 'New Name' }, 'user-1');

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_UPDATED' }),
      );
    });
  });

  describe('remove', () => {
    it('should soft delete an organization', async () => {
      const existing = { id: 'org-1', code: 'TEST', name: 'Test Org', isActive: true };
      mockOrgRepo.findOne.mockResolvedValue(existing);
      mockOrgRepo.save.mockImplementation((e) => Promise.resolve(e));

      await service.remove('org-1', 'user-1');

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'ORGANIZATION_DELETED' }),
      );
      expect(existing.isActive).toBe(false);
    });
  });
});
