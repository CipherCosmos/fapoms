import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ValidationQueryController } from './validation-query.controller';
import { ValidationQueryService } from './validation-query.service';
import { QueryThreadService } from './query-thread.service';
import { DocumentAccessTokenService } from '../document/document-access-token.service';
import { FileScanInterceptor } from '../../infrastructure/security/file-scan.interceptor';
import { FileScanService } from '../../infrastructure/security/file-scan.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { SystemRole } from '@fapoms/shared';

/**
 * Pins the fix for the validation-query read IDOR (originally closed in 038d069c, then lost
 * and restored here): every read/respond route on this controller admits SystemRole.ASSAYER
 * — the lowest-privilege, external mobile principal — but none of them had an object-level
 * ownership check. Any assayer could page the entire `validation_queries` table, read another
 * assayer's clarifications by id or path param, pull any case's full thread, and mark any
 * query as answered.
 *
 * These tests assert an assayer caller is pinned to their own records on every one of the five
 * affected routes, and that a staff caller (who is not object-scoped here at all) is unaffected.
 */
describe('ValidationQueryController — assayer ownership on read/respond routes', () => {
  let controller: ValidationQueryController;

  const ME = 'assayer-me';
  const SOMEONE_ELSE = 'assayer-someone-else';

  const mockService = {
    findByAssayer: jest.fn(),
    findByValidationCase: jest.fn(),
    ownerAssayerId: jest.fn(),
    respondToQuery: jest.fn(),
    findAllQueries: jest.fn(),
  };

  const mockThreadService = {
    listMessages: jest.fn(),
    getQueryDocumentId: jest.fn(),
    queryIdForAttachmentKey: jest.fn(),
  };

  const mockDocumentAccessTokenService = {
    issue: jest.fn().mockReturnValue({ token: 'tok', expiresAt: new Date().toISOString() }),
  };

  const mockStorage = {};

  // None of the tests below supply a `@GlobalScopeFilter()` scope (that decorator only resolves
  // through the real HTTP pipeline), so every staged region-scope call the controller makes is
  // short-circuited before it ever reaches `RegionGuardService` — this mock exists purely so
  // Nest can resolve the controller's constructor, not because any test here exercises it. See
  // `validation-query-region-scope.spec.ts` for the region-scoping coverage itself.
  const mockRegionGuard = { assertRegionAllowedStaged: jest.fn(), stagedMode: jest.fn() };

  const assayerReq = (id: string) => ({ user: { id, roles: [SystemRole.ASSAYER] } });
  const staffReq = (id = 'staff-1', role: SystemRole = SystemRole.DESK) => ({ user: { id, roles: [role] } });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ValidationQueryController],
      providers: [
        { provide: ValidationQueryService, useValue: mockService },
        { provide: QueryThreadService, useValue: mockThreadService },
        { provide: 'StorageEngine', useValue: mockStorage },
        { provide: DocumentAccessTokenService, useValue: mockDocumentAccessTokenService },
        { provide: RegionGuardService, useValue: mockRegionGuard },
        // Pulled in only because FileScanInterceptor is referenced via @UseInterceptors on the
        // upload routes — this suite never exercises those, but Nest still resolves the DI graph.
        { provide: FileScanService, useValue: {} },
        FileScanInterceptor,
      ],
    }).compile();

    controller = module.get<ValidationQueryController>(ValidationQueryController);
  });

  describe('GET / (findAll)', () => {
    it('ignores an assayer-supplied assayerId and returns only their own queries', async () => {
      mockService.findByAssayer.mockResolvedValue([{ id: 'q-1', assayerId: ME }]);

      const res = await controller.findAll(assayerReq(ME) as any, SOMEONE_ELSE, undefined, undefined);

      expect(mockService.findByAssayer).toHaveBeenCalledWith(ME);
      expect(mockService.findByAssayer).not.toHaveBeenCalledWith(SOMEONE_ELSE);
      expect(res.data).toEqual([{ id: 'q-1', assayerId: ME }]);
    });

    it('leaves a staff caller free to page the whole table or filter by assayerId', async () => {
      mockService.findAllQueries.mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 });

      await controller.findAll(staffReq() as any, undefined, undefined, undefined);
      expect(mockService.findAllQueries).toHaveBeenCalled();

      mockService.findByAssayer.mockResolvedValue([{ id: 'q-2', assayerId: SOMEONE_ELSE }]);
      const res = await controller.findAll(staffReq() as any, SOMEONE_ELSE, undefined, undefined);
      expect(mockService.findByAssayer).toHaveBeenCalledWith(SOMEONE_ELSE);
      expect(res.data).toEqual([{ id: 'q-2', assayerId: SOMEONE_ELSE }]);
    });
  });

  describe('POST /:id/respond', () => {
    it('refuses an assayer responding to a clarification that is not theirs, before the service mutates anything', async () => {
      mockService.ownerAssayerId.mockResolvedValue(SOMEONE_ELSE);

      await expect(
        controller.respondToQuery('q-1', { response: 'answer' } as any, assayerReq(ME) as any),
      ).rejects.toThrow(ForbiddenException);
      expect(mockService.respondToQuery).not.toHaveBeenCalled();
    });

    it('404s an assayer responding to a clarification id that does not exist', async () => {
      mockService.ownerAssayerId.mockResolvedValue(undefined);

      await expect(
        controller.respondToQuery('missing', { response: 'answer' } as any, assayerReq(ME) as any),
      ).rejects.toThrow(NotFoundException);
      expect(mockService.respondToQuery).not.toHaveBeenCalled();
    });

    it('allows an assayer to respond to their own clarification', async () => {
      mockService.ownerAssayerId.mockResolvedValue(ME);
      mockService.respondToQuery.mockResolvedValue({ id: 'q-1', status: 'RESPONDED' });

      const res = await controller.respondToQuery('q-1', { response: 'answer' } as any, assayerReq(ME) as any);

      expect(mockService.respondToQuery).toHaveBeenCalledWith('q-1', 'answer', ME, undefined);
      expect(res.success).toBe(true);
    });

    it('never object-scopes a staff caller', async () => {
      mockService.respondToQuery.mockResolvedValue({ id: 'q-1', status: 'RESPONDED' });

      await controller.respondToQuery('q-1', { response: 'answer' } as any, staffReq() as any);

      expect(mockService.ownerAssayerId).not.toHaveBeenCalled();
      expect(mockService.respondToQuery).toHaveBeenCalled();
    });
  });

  describe('GET /validation-case/:validationCaseId (findByValidationCase)', () => {
    it('filters an assayer down to only their own queries within the case', async () => {
      mockService.findByValidationCase.mockResolvedValue([
        { id: 'q-1', assayerId: ME },
        { id: 'q-2', assayerId: SOMEONE_ELSE },
      ]);

      const res = await controller.findByValidationCase('case-1', assayerReq(ME) as any);

      expect(res.data).toEqual([{ id: 'q-1', assayerId: ME }]);
    });

    it('leaves the full case thread visible to staff', async () => {
      mockService.findByValidationCase.mockResolvedValue([
        { id: 'q-1', assayerId: ME },
        { id: 'q-2', assayerId: SOMEONE_ELSE },
      ]);

      const res = await controller.findByValidationCase('case-1', staffReq() as any);

      expect(res.data).toHaveLength(2);
    });
  });

  describe('GET /assayer/:assayerId (findByAssayer)', () => {
    it('ignores the path param for an assayer caller and uses their own id instead', async () => {
      mockService.findByAssayer.mockResolvedValue([{ id: 'q-1', assayerId: ME }]);

      await controller.findByAssayer(SOMEONE_ELSE, assayerReq(ME) as any);

      expect(mockService.findByAssayer).toHaveBeenCalledWith(ME);
      expect(mockService.findByAssayer).not.toHaveBeenCalledWith(SOMEONE_ELSE);
    });

    it('honours the path param for a staff caller', async () => {
      mockService.findByAssayer.mockResolvedValue([{ id: 'q-1', assayerId: SOMEONE_ELSE }]);

      await controller.findByAssayer(SOMEONE_ELSE, staffReq() as any);

      expect(mockService.findByAssayer).toHaveBeenCalledWith(SOMEONE_ELSE);
    });
  });

  describe('GET /:id/messages (listMessages)', () => {
    it('refuses an assayer reading a thread on a clarification that is not theirs', async () => {
      mockService.ownerAssayerId.mockResolvedValue(SOMEONE_ELSE);

      await expect(controller.listMessages('q-1', assayerReq(ME) as any)).rejects.toThrow(ForbiddenException);
      expect(mockThreadService.listMessages).not.toHaveBeenCalled();
    });

    it('404s an assayer reading a thread on a clarification id that does not exist', async () => {
      mockService.ownerAssayerId.mockResolvedValue(undefined);

      await expect(controller.listMessages('missing', assayerReq(ME) as any)).rejects.toThrow(NotFoundException);
      expect(mockThreadService.listMessages).not.toHaveBeenCalled();
    });

    it('lets an assayer read their own thread', async () => {
      mockService.ownerAssayerId.mockResolvedValue(ME);
      mockThreadService.listMessages.mockResolvedValue([{ id: 'm-1', pageNumber: null, region: null, snapshotPath: null }]);
      mockThreadService.getQueryDocumentId.mockResolvedValue(null);

      const res = await controller.listMessages('q-1', assayerReq(ME) as any);

      expect(res.success).toBe(true);
      expect(mockThreadService.listMessages).toHaveBeenCalledWith('q-1');
    });

    it('never object-scopes a staff caller', async () => {
      mockThreadService.listMessages.mockResolvedValue([]);
      mockThreadService.getQueryDocumentId.mockResolvedValue(null);

      await controller.listMessages('q-1', staffReq() as any);

      expect(mockService.ownerAssayerId).not.toHaveBeenCalled();
      expect(mockThreadService.listMessages).toHaveBeenCalledWith('q-1');
    });
  });

  /**
   * Pins the fix for the attachment-token IDOR: `issueAttachmentToken` used to HMAC-sign a
   * download token for whatever `key` the caller supplied, with no lookup at all — any of the
   * four roles this route admits could mint a valid token for ANY object in the bucket by
   * guessing or reusing a key. The fix resolves `key` back to the clarification message it
   * belongs to via `queryIdForAttachmentKey`, 404s a key that resolves to nothing, and then runs
   * it through the same `assertAssayerOwnsQuery` gate the other routes in this file use.
   */
  describe('GET /attachment-token (issueAttachmentToken)', () => {
    it('404s a key that does not resolve to any clarification attachment', async () => {
      mockThreadService.queryIdForAttachmentKey.mockResolvedValue(null);

      await expect(
        controller.issueAttachmentToken('some/arbitrary/bucket/key.pdf', assayerReq(ME) as any),
      ).rejects.toThrow(NotFoundException);
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });

    it('404s an unresolved key for a staff caller too — the lookup itself is not object-scoping', async () => {
      mockThreadService.queryIdForAttachmentKey.mockResolvedValue(null);

      await expect(
        controller.issueAttachmentToken('some/arbitrary/bucket/key.pdf', staffReq() as any),
      ).rejects.toThrow(NotFoundException);
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });

    it('refuses an assayer minting a token for an attachment on a clarification that is not theirs', async () => {
      mockThreadService.queryIdForAttachmentKey.mockResolvedValue('q-1');
      mockService.ownerAssayerId.mockResolvedValue(SOMEONE_ELSE);

      await expect(
        controller.issueAttachmentToken('chat/photo.jpg', assayerReq(ME) as any),
      ).rejects.toThrow(ForbiddenException);
      expect(mockDocumentAccessTokenService.issue).not.toHaveBeenCalled();
    });

    it('allows an assayer to mint a token for an attachment on their own clarification', async () => {
      mockThreadService.queryIdForAttachmentKey.mockResolvedValue('q-1');
      mockService.ownerAssayerId.mockResolvedValue(ME);

      const res = await controller.issueAttachmentToken('chat/photo.jpg', assayerReq(ME) as any);

      expect(mockDocumentAccessTokenService.issue).toHaveBeenCalledWith('chat/photo.jpg');
      expect(res.success).toBe(true);
      expect(res.data.downloadUrl).toContain(encodeURIComponent('chat/photo.jpg'));
    });

    it('never object-scopes a staff caller once the key resolves to a real attachment', async () => {
      mockThreadService.queryIdForAttachmentKey.mockResolvedValue('q-1');

      const res = await controller.issueAttachmentToken('chat/photo.jpg', staffReq() as any);

      expect(mockService.ownerAssayerId).not.toHaveBeenCalled();
      expect(mockDocumentAccessTokenService.issue).toHaveBeenCalledWith('chat/photo.jpg');
      expect(res.success).toBe(true);
    });
  });
});
