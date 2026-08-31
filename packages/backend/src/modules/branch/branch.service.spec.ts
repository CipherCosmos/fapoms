import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
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
import { BranchQueryService } from './branch-query.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { GeoPrecisionService } from '../geo/geo-precision.service';

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
  const mockAuditService = { recordEvent: jest.fn() , recordEventSafe: jest.fn(function (this: any, dto: any) { return this.recordEvent(dto); })};

  const mockBranchQueryService = {
    findOne: jest.fn().mockImplementation((id) => Promise.resolve({ id, name: 'Branch 1' })),
    findAll: jest.fn().mockResolvedValue({ branches: [], total: 0 }),
  };

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
        { provide: BranchQueryService, useValue: mockBranchQueryService },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        // The bulk importer's hand-off to the precision worker; fire-and-forget, never awaited.
        { provide: GeoPrecisionService, useValue: { enqueueBackfill: jest.fn().mockResolvedValue(undefined) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
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
        // The state is now checked on its own, offline, against the canonical list of Indian
        // states — so an unreal state is named as such instead of being reported as part of an
        // unresolvable address. District and city are only cross-checked when the optional place
        // lookup is configured to answer.
      ).rejects.toThrow(/Could not verify 'UnknownState' as a real state/);
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

    /**
     * The place lookup is optional, and when it is unconfigured it answers every query with an
     * empty list. That used to be read as "no such place", so with the curated tables holding
     * only 22 cities, every real branch — none of which matched them — was refused, and the
     * message blamed the operator's spelling for a missing API key.
     */
    it('accepts a real address the optional place lookup cannot confirm', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;
      // Not in the curated reference tables, which is the normal case for a real branch.
      mockStateRepo.findOne.mockResolvedValue(null);
      mockDistrictRepo.findOne.mockResolvedValue(null);
      mockCityRepo.findOne.mockResolvedValue(null);
      mockBranchRepo.create.mockReturnValue({ id: 'b-2', branchCode: 'B-2' });
      mockBranchRepo.save.mockResolvedValue({ id: 'b-2', branchCode: 'B-2' });

      const result = await service.create(
        {
          branchCode: 'B-2',
          name: 'Andheri West',
          address: 'SV Road',
          state: 'MAHARASHTRA',
          district: 'MUMBAI',
          city: 'MUMBAI',
        },
        'user-1',
      );

      expect(result.branchCode).toBe('B-2');
    });

    it('still refuses a state that is not a real state, with no lookup configured', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;
      mockStateRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          { branchCode: 'B-3', name: 'Nowhere', address: 'X', state: 'NARNIA', district: 'D', city: 'C' },
          'user-1',
        ),
      ).rejects.toThrow(/Could not verify 'NARNIA' as a real state/);
    });
  });

  /**
   * A branch is identified by its ids, per client — never its name, which two banks share for a
   * branch at one address. Uniqueness is enforced per (client, id); a different bank keeps its
   * own numbering.
   */
  describe('branch identity — Branch Code and SOL ID are unique per client', () => {
    const realState = { state: 'MAHARASHTRA', district: 'MUMBAI', city: 'MUMBAI' };

    it('refuses a Branch Code already used by the same client', async () => {
      mockBranchRepo.findOne.mockResolvedValue({ id: 'existing', branchCode: 'BR-1' });
      await expect(
        service.create({ branchCode: 'BR-1', name: 'MG Road', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/Branch Code 'BR-1' is already used/);
    });

    it('refuses a SOL ID already used by the same client', async () => {
      // First lookup (branch code) is free; second (SOL ID) hits the conflict.
      mockBranchRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'existing', solId: '0001' });
      await expect(
        service.create({ branchCode: 'BR-2', solId: '0001', name: 'MG Road', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/SOL ID '0001' is already used/);
    });

    it('allows the same code for a DIFFERENT client — banks keep their own numbering', async () => {
      // No existing branch for THIS client with that code/sol.
      mockBranchRepo.findOne.mockResolvedValue(null);
      mockClientService.findOne.mockResolvedValue({ id: 'icici', name: 'ICICI' });
      mockBranchRepo.create.mockReturnValue({ id: 'b-new', branchCode: 'BR-1' });
      mockBranchRepo.save.mockResolvedValue({ id: 'b-new', branchCode: 'BR-1' });
      const result = await service.create(
        { branchCode: 'BR-1', solId: '0001', name: 'MG Road', ...realState, clientId: 'icici' },
        'user-1',
      );
      expect(result.branchCode).toBe('BR-1');
    });
  });

  describe('findOne', () => {
    it('should throw NotFoundException if branch does not exist', async () => {
      mockBranchQueryService.findOne.mockRejectedValueOnce(new NotFoundException('Branch non-existent-id not found.'));

      await expect(service.findOne('non-existent-id')).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * Adding a contact or document was audited; removing one was not. For an audit business the
   * removal is the more consequential half — it is what makes evidence stop being visible.
   */
  describe('removals leave a trail', () => {
    it('records who removed a branch contact, and what was removed', async () => {
      mockContactRepo.findOne.mockResolvedValue({
        id: 'ct-1', branchId: 'br-1', name: 'Ravi Kumar', designation: 'Manager',
        email: 'ravi@bank.example', phone: '9000000000', isActive: true,
      });
      mockContactRepo.save.mockImplementation(async (c: any) => c);

      await service.removeContact('ct-1', 'user-9');

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'BRANCH_CONTACT_REMOVED',
          entityType: 'BRANCH',
          entityId: 'br-1',
          userId: 'user-9',
          metadata: expect.objectContaining({ contactId: 'ct-1', name: 'Ravi Kumar' }),
        }),
      );
    });

    it('records who removed a branch document, and which file', async () => {
      mockDocumentRepo.findOne.mockResolvedValue({
        id: 'doc-1', branchId: 'br-1', fileName: 'vault-register.pdf',
        category: 'EVIDENCE', filePath: '/docs/vault-register.pdf', isActive: true,
      });
      mockDocumentRepo.save.mockImplementation(async (d: any) => d);

      await service.removeDocument('doc-1', 'user-9');

      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'BRANCH_DOCUMENT_REMOVED',
          entityType: 'BRANCH',
          entityId: 'br-1',
          userId: 'user-9',
          metadata: expect.objectContaining({ documentId: 'doc-1', fileName: 'vault-register.pdf' }),
        }),
      );
    });
  });

});
