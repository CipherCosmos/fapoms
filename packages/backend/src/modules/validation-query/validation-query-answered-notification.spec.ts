import { Test } from '@nestjs/testing';
import { ValidationQueryService } from './validation-query.service';
import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationCaseEntity } from '../validation/validation-case.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationService } from '../notifications/notification.service';
import { PushNotificationService } from '../notifications/push-notification.service';
import { QueryThreadService } from './query-thread.service';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';
import { ValidationQueryStatus } from '@fapoms/shared';

/**
 * Reproduces the bug live-found 2026-09-04: a branch re-assigned since a query was raised made
 * `VALIDATION_QUERY_ANSWERED` name whoever currently holds the branch, not who actually answered.
 * The two assayers below are deliberately different people on the deliberately same branch — the
 * exact shape that made the old code (one lookup, shared between assayerName and branchName) wrong.
 */
describe('ValidationQueryService — VALIDATION_QUERY_ANSWERED names the answering assayer', () => {
  const QUERYING_ASSAYER_ID = 'assayer-who-answered';
  const CURRENTLY_ACTIVE_ASSAYER_ID = 'assayer-now-on-the-branch';
  const BRANCH_ID = 'branch-1';
  const PROJECT_BRANCH_ID = 'pb-1';

  let service: ValidationQueryService;
  let emitSafe: jest.Mock;
  let assignmentRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    emitSafe = jest.fn();
    assignmentRepo = { findOne: jest.fn() };

    const queryRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: 'q-1',
        assayerId: QUERYING_ASSAYER_ID,
        validationCaseId: 'case-1',
        status: ValidationQueryStatus.OPEN,
      }),
      save: jest.fn().mockImplementation(async (q) => ({ ...q, respondedAt: new Date() })),
    };
    const validationCaseRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 'case-1', projectBranchId: PROJECT_BRANCH_ID }),
    };

    const module = await Test.createTestingModule({
      providers: [
        ValidationQueryService,
        { provide: require('@nestjs/typeorm').getRepositoryToken(ValidationQueryEntity), useValue: queryRepo },
        { provide: require('@nestjs/typeorm').getRepositoryToken(ValidationCaseEntity), useValue: validationCaseRepo },
        { provide: require('@nestjs/typeorm').getRepositoryToken(AssignmentEntity), useValue: assignmentRepo },
        { provide: AuditService, useValue: { recordEvent: jest.fn() } },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: NotificationService, useValue: {} },
        { provide: PushNotificationService, useValue: {} },
        { provide: QueryThreadService, useValue: { postMessage: jest.fn().mockResolvedValue(undefined) } },
        { provide: NotificationDispatchService, useValue: { emitSafe } },
        { provide: RegionGuardService, useValue: {} },
      ],
    }).compile();

    service = module.get(ValidationQueryService);
  });

  it('names the assayer who answered, not whoever is currently active on the branch', async () => {
    // Two different assignment rows on the same branch: the branch's CURRENT active assignment
    // (a different assayer — the branch was re-assigned since the query was raised), and a past
    // row belonging to the assayer who actually raised/answered this query.
    assignmentRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where.assayerId === QUERYING_ASSAYER_ID) {
        return {
          assayer: { displayName: 'Bharathsimha Reddy Boojja' },
        };
      }
      if (where.isActive === true) {
        return {
          assayer: { displayName: 'Nilesh Rahane' }, // wrong person — currently active, not the answerer
          projectBranch: { branch: { id: BRANCH_ID, name: 'Pune Camp Branch' } },
        };
      }
      return null;
    });

    await service.respondToQuery('q-1', 'confirmed, 42.85kg', 'user-1');

    expect(emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'VALIDATION_QUERY_ANSWERED',
        payload: expect.objectContaining({
          assayerName: 'Bharathsimha Reddy Boojja',
          branchName: 'Pune Camp Branch',
        }),
      }),
    );
  });

  it('falls back to generic text when the answering assayer has no assignment row at all', async () => {
    assignmentRepo.findOne.mockResolvedValue(null);

    await service.respondToQuery('q-1', 'confirmed', 'user-1');

    expect(emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          assayerName: 'The assayer',
          branchName: 'a branch',
        }),
      }),
    );
  });
});
