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
    // The SOL-ID uniqueness check reads through `find` (take: 2) rather than `findOne`, because it
    // must see archived rows too and still exclude the branch being edited. Default: nothing taken.
    find: jest.fn().mockResolvedValue([]),
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
            solId: 'B-1',
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
        solId: 'B-1',
        name: 'Pune Branch',
      };
      mockBranchRepo.create.mockReturnValue(mockCreatedBranch);
      mockBranchRepo.save.mockResolvedValue(mockCreatedBranch);

      const result = await service.create(
        {
          solId: 'B-1',
          name: 'Pune Branch',
          address: '123 Main St',
          state: 'MH',
          district: 'Pune',
          city: 'Pune City',
        },
        'user-1',
      );

      expect(result.solId).toBe('B-1');
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
      mockBranchRepo.create.mockReturnValue({ id: 'b-2', solId: 'B-2' });
      mockBranchRepo.save.mockResolvedValue({ id: 'b-2', solId: 'B-2' });

      const result = await service.create(
        {
          solId: 'B-2',
          name: 'Andheri West',
          address: 'SV Road',
          state: 'MAHARASHTRA',
          district: 'MUMBAI',
          city: 'MUMBAI',
        },
        'user-1',
      );

      expect(result.solId).toBe('B-2');
    });

    it('still refuses a state that is not a real state, with no lookup configured', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;
      mockStateRepo.findOne.mockResolvedValue(null);

      await expect(
        service.create(
          { solId: 'B-3', name: 'Nowhere', address: 'X', state: 'NARNIA', district: 'D', city: 'C' },
          'user-1',
        ),
      ).rejects.toThrow(/Could not verify 'NARNIA' as a real state/);
    });
  });

  /**
   * A branch is identified by its SOL ID, per client — never its name, which two banks share for a
   * branch at one address. Uniqueness is enforced per (client, sol_id); a different bank keeps its
   * own numbering.
   */
  describe('branch identity — SOL ID is unique per client', () => {
    const realState = { state: 'MAHARASHTRA', district: 'MUMBAI', city: 'MUMBAI' };

    it('refuses a SOL ID already used by the same client', async () => {
      mockBranchRepo.find.mockResolvedValue([{ id: 'existing', solId: '0001', name: 'Fort', isActive: true }]);
      await expect(
        service.create({ solId: '0001', name: 'MG Road', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/SOL ID '0001' is already used/);
    });

    it('refuses a branch with no SOL ID — it is the required identity', async () => {
      await expect(
        service.create({ solId: '', name: 'MG Road', ...realState, clientId: 'axis' } as any, 'user-1'),
      ).rejects.toThrow(/SOL ID is required/i);
    });

    /**
     * The duplicate this used to create.
     *
     * The check filtered `isActive: true`, and so does the database's unique index
     * (`UQ_branches_client_sol_id ... WHERE is_active = true`). Archive branch 4021 and create it
     * again and you get a *second* row with the same client and SOL ID beside the archived one —
     * permitted by Postgres, invisible to the code, and impossible for any later import to tell
     * apart. One of the two carries all the history.
     */
    it('refuses a SOL ID held by an ARCHIVED branch, and says how to resolve it', async () => {
      mockBranchRepo.find.mockResolvedValue([
        { id: 'archived', solId: '0001', name: 'Fort (old)', isActive: false },
      ]);

      await expect(
        service.create({ solId: '0001', name: 'Fort', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/archived branch/i);
      // The operator cannot see the archived branch in any list, so the message has to tell them
      // what to do about it rather than just refusing.
      await expect(
        service.create({ solId: '0001', name: 'Fort', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/Restore that branch/i);
      expect(mockBranchRepo.save).not.toHaveBeenCalled();
    });

    /**
     * The check and the insert are not atomic. Two operators adding the same branch at once both
     * find the SOL ID free; the database's unique index rejects the loser. Without this, that
     * arrives as a raw `duplicate key value violates unique constraint` 500.
     */
    it('turns a lost race into the same readable conflict, not a 500', async () => {
      mockBranchRepo.find
        .mockResolvedValueOnce([])                                                     // the check: free
        .mockResolvedValue([{ id: 'winner', solId: '0001', name: 'Fort', isActive: true }]); // after
      mockClientService.findOne.mockResolvedValue({ id: 'axis', name: 'Axis' });
      mockBranchRepo.create.mockReturnValue({ id: 'b-new', solId: '0001' });
      mockBranchRepo.save.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(
        service.create({ solId: '0001', name: 'Fort', ...realState, clientId: 'axis' }, 'user-1'),
      ).rejects.toThrow(/already used by "Fort"/);
    });

    /**
     * `update` did `if (dto.solId !== undefined) branch.solId = dto.solId` and saved — no trim, no
     * blank check, no collision check — while `create` a hundred lines above refused all three. The
     * SOL ID is the field every import matches on, so a blank one makes the branch unmatchable and
     * surfaces later as a duplicate rather than as an error here.
     */
    it('refuses to blank a SOL ID from the edit form', async () => {
      mockBranchQueryService.findOne.mockResolvedValue({
        id: 'b-1', solId: '0001', name: 'Fort', clientId: 'axis', isActive: true,
      });

      await expect(service.update('b-1', { solId: '   ' }, 'user-1')).rejects.toThrow(/SOL ID is required/i);
      expect(mockBranchRepo.save).not.toHaveBeenCalled();
    });

    it('refuses to point one branch at another branch\'s SOL ID from the edit form', async () => {
      mockBranchQueryService.findOne.mockResolvedValue({
        id: 'b-1', solId: '0001', name: 'Fort', clientId: 'axis', isActive: true,
      });
      mockBranchRepo.find.mockResolvedValue([
        { id: 'b-2', solId: '0002', name: 'Andheri', isActive: true },
      ]);

      await expect(service.update('b-1', { solId: '0002' }, 'user-1')).rejects.toThrow(/already used by "Andheri"/);
    });

    it('lets a branch keep its own SOL ID through an unrelated edit', async () => {
      mockBranchQueryService.findOne.mockResolvedValue({
        id: 'b-1', solId: '0001', name: 'Fort', clientId: 'axis', isActive: true,
      });
      mockBranchRepo.find.mockResolvedValue([]);
      mockBranchRepo.save.mockResolvedValue({ id: 'b-1', solId: '0001', phone: '9000000000' });

      await expect(service.update('b-1', { solId: '0001', phone: '9000000000' }, 'user-1')).resolves.toBeDefined();
    });
  });

  /**
   * Restoring is its own act, not a field on the edit DTO — see `restoreArchived`.
   */
  describe('restoreArchived', () => {
    it('brings an archived branch back and records why', async () => {
      // Read through the repository, not `BranchQueryService.findOne` — that one ends
      // `.andWhere('branch.isActive = true')` and so cannot see the very row being restored.
      mockBranchRepo.findOne.mockResolvedValue({
        id: 'b-1', solId: '0001', name: 'Fort', isActive: false,
      });
      mockBranchRepo.save.mockImplementation(async (b: any) => b);

      const restored = await service.restoreArchived('b-1', 'user-1');

      expect(restored.isActive).toBe(true);
      expect(mockAuditService.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'BRANCH_RESTORED' }),
      );
    });

    it('is a no-op on a branch that is already active', async () => {
      mockBranchRepo.findOne.mockResolvedValue({ id: 'b-1', solId: '0001', isActive: true });
      mockBranchRepo.save.mockClear();

      await service.restoreArchived('b-1', 'user-1');

      expect(mockBranchRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('branch identity — trailing cases', () => {
    const realState = { state: 'MAHARASHTRA', district: 'MUMBAI', city: 'MUMBAI' };

    it('allows the same SOL ID for a DIFFERENT client — banks keep their own numbering', async () => {
      // No existing branch for THIS client with that SOL ID.
      mockBranchRepo.find.mockResolvedValue([]);
      mockClientService.findOne.mockResolvedValue({ id: 'icici', name: 'ICICI' });
      mockBranchRepo.create.mockReturnValue({ id: 'b-new', solId: '0001' });
      mockBranchRepo.save.mockResolvedValue({ id: 'b-new', solId: '0001' });
      const result = await service.create(
        { solId: '0001', name: 'MG Road', ...realState, clientId: 'icici' },
        'user-1',
      );
      expect(result.solId).toBe('0001');
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
