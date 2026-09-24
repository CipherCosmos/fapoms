import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DocumentStatus, DocumentType, SystemRole } from '@fapoms/shared';
import { DocumentController } from './document.controller';
import { DocumentService } from './document.service';

/**
 * The document write routes that had no ownership or region check:
 *  - POST :id/receive admitted any ASSAYER for any document, and staff with no region ceiling;
 *  - PATCH :id/status, send-external-ocr, assign-data-entry, complete-data-entry had no region
 *    ceiling;
 *  - complete-data-entry let any desk member hand back a packet delegated to someone else;
 *  - assign-data-entry wrote any string as the assignee.
 */

const SCOPE = { regions: ['NORTH'] } as any;

function controllerWith(service: Record<string, any>, regionGuard: Record<string, any>) {
  return new DocumentController(
    service as any,
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any, null as any,
    regionGuard as any, null as any,
    null as any,
  );
}

describe('document write routes carry ownership and region checks', () => {
  const doc = { id: 'doc-1', assessment: { branch: { region: 'SOUTH' } } };
  let service: Record<string, jest.Mock>;
  let regionGuard: { assertRegionAllowedStaged: jest.Mock };
  let controller: DocumentController;

  beforeEach(() => {
    service = {
      findOne: jest.fn(async () => doc),
      receiveDocument: jest.fn(async () => ({ id: 'doc-1' })),
      assertAssayerMayReceive: jest.fn(async () => undefined),
      updateStatus: jest.fn(async () => ({ id: 'doc-1' })),
      markSentToExternalOcr: jest.fn(async () => ({ id: 'doc-1' })),
      assignForDataEntry: jest.fn(async () => ({ id: 'doc-1' })),
      completeDataEntry: jest.fn(async () => ({ id: 'doc-1' })),
    };
    // Refuses the other region, as the real guard does for a region-scoped caller.
    regionGuard = {
      assertRegionAllowedStaged: jest.fn(async (region: string | null, scope: any) => {
        if (scope?.regions?.length && region && !scope.regions.includes(region)) {
          throw new ForbiddenException('outside your region');
        }
      }),
    };
    controller = controllerWith(service, regionGuard);
  });

  const staff = { user: { id: 'u-1', roles: [SystemRole.DESK] } };

  it('receive: a pure assayer must own the branch; the ownership check runs before the write', async () => {
    const assayer = { user: { id: 'a-1', assayerId: 'a-1', roles: [SystemRole.ASSAYER] } };
    service.assertAssayerMayReceive.mockRejectedValueOnce(new ForbiddenException('not yours'));
    await expect(controller.receiveDocument('doc-1', assayer)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.assertAssayerMayReceive).toHaveBeenCalledWith('doc-1', 'a-1');
    expect(service.receiveDocument).not.toHaveBeenCalled();
  });

  it('receive: staff outside the document region are refused before the write', async () => {
    await expect(controller.receiveDocument('doc-1', staff, SCOPE)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.receiveDocument).not.toHaveBeenCalled();
  });

  it('PATCH status refuses another region', async () => {
    await expect(
      controller.updateStatus('doc-1', { status: DocumentStatus.PROCESSED } as any, staff, SCOPE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.updateStatus).not.toHaveBeenCalled();
  });

  it('send-external-ocr refuses another region', async () => {
    await expect(controller.sendToExternalOcr('doc-1', staff, SCOPE)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.markSentToExternalOcr).not.toHaveBeenCalled();
  });

  it('assign-data-entry refuses another region', async () => {
    await expect(
      controller.assignDataEntry('doc-1', { assigneeId: 'u-2' } as any, staff, SCOPE),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.assignForDataEntry).not.toHaveBeenCalled();
  });

  it('complete-data-entry refuses another region, and passes the caller roles to the service', async () => {
    await expect(controller.completeDataEntry('doc-1', staff, SCOPE)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.completeDataEntry).not.toHaveBeenCalled();
    await controller.completeDataEntry('doc-1', staff, { regions: ['SOUTH'] } as any);
    expect(service.completeDataEntry).toHaveBeenCalledWith('doc-1', 'u-1', [SystemRole.DESK]);
  });
});

describe('DocumentService data-entry and receive rules', () => {
  function serviceWith(overrides: Record<string, any>): DocumentService {
    const svc = Object.create(DocumentService.prototype);
    Object.assign(svc, overrides);
    return svc as DocumentService;
  }

  describe('completeDataEntry', () => {
    // Already handed back, so a caller who passes the actor check stops at the next rule
    // (a BadRequest) without the test needing the save/audit/notify machinery.
    const packet = () => ({ id: 'doc-1', assignedToUserId: 'op-1', dataEntryCompletedAt: new Date('2026-09-01') });

    it('refuses a desk operator handing back a colleague\'s packet', async () => {
      const svc = serviceWith({ findOne: jest.fn(async () => packet()) });
      await expect(svc.completeDataEntry('doc-1', 'op-2', [SystemRole.DESK_OPERATOR])).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc.completeDataEntry('doc-1', 'op-2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the assignee, the desk head and ADMIN through the actor check', async () => {
      const svc = serviceWith({ findOne: jest.fn(async () => packet()) });
      await expect(svc.completeDataEntry('doc-1', 'op-1', [SystemRole.DESK_OPERATOR])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.completeDataEntry('doc-1', 'head', [SystemRole.DESK])).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.completeDataEntry('doc-1', 'boss', [SystemRole.ADMIN])).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('assignForDataEntry', () => {
    const received = () => ({ id: 'doc-1', type: DocumentType.AUDITED_RETURN_PDF, status: DocumentStatus.RECEIVED });

    it('refuses an assignee who is not an active desk member, without writing', async () => {
      const save = jest.fn();
      const query = jest.fn(async () => []);
      const svc = serviceWith({ findOne: jest.fn(async () => received()), documentRepository: { manager: { query }, save } });
      await expect(svc.assignForDataEntry('doc-1', 'nobody', 'head')).rejects.toThrow(/only an active member of the data entry desk/);
      expect(save).not.toHaveBeenCalled();
      const [sql, params] = (query.mock.calls[0] as unknown) as [string, any[]];
      expect(sql).toMatch(/is_active = true/);
      expect(params).toEqual(['nobody', [SystemRole.DESK, SystemRole.DESK_OPERATOR]]);
    });

    it('proceeds to the write for an eligible assignee', async () => {
      const save = jest.fn(async () => { throw new Error('reached-save'); });
      const svc = serviceWith({
        findOne: jest.fn(async () => received()),
        documentRepository: { manager: { query: jest.fn(async () => [{ id: 'op-1' }]) }, save },
      });
      await expect(svc.assignForDataEntry('doc-1', 'op-1', 'head')).rejects.toThrow('reached-save');
    });
  });

  describe('assertAssayerMayReceive', () => {
    const qb = (count: number) => {
      const chain: any = {};
      for (const m of ['innerJoin', 'where', 'andWhere']) chain[m] = jest.fn(() => chain);
      chain.getCount = jest.fn(async () => count);
      return chain;
    };

    it('refuses an assayer with no engaged assignment on the branch', async () => {
      const svc = serviceWith({
        findOne: jest.fn(async () => ({ id: 'doc-1', assessmentId: 'as-1' })),
        assessmentRepository: { findOne: jest.fn(async () => ({ projectId: 'p', branchId: 'b' })) },
        assignmentRepository: { createQueryBuilder: jest.fn(() => qb(0)) },
      });
      await expect(svc.assertAssayerMayReceive('doc-1', 'a-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a document with no assessment to prove ownership against', async () => {
      const svc = serviceWith({ findOne: jest.fn(async () => ({ id: 'doc-1', assessmentId: null })) });
      await expect(svc.assertAssayerMayReceive('doc-1', 'a-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admits the assayer holding the branch', async () => {
      const svc = serviceWith({
        findOne: jest.fn(async () => ({ id: 'doc-1', assessmentId: 'as-1' })),
        assessmentRepository: { findOne: jest.fn(async () => ({ projectId: 'p', branchId: 'b' })) },
        assignmentRepository: { createQueryBuilder: jest.fn(() => qb(1)) },
      });
      await expect(svc.assertAssayerMayReceive('doc-1', 'a-1')).resolves.toBeUndefined();
    });
  });
});
