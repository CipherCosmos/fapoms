import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * A new account belongs to the organisation of whoever created it.
 *
 * `createUser` never set `organizationId` at all. The account was created, the password worked,
 * the login succeeded — and then every organisation-scoped screen answered 403 "Your account is
 * not linked to an organisation", because `tenantScope()` refuses a null organisation for any
 * role outside ADMIN/DEVELOPER. Ten accounts on the live database were already in that state
 * before an end-to-end certification run walked into it while trying to create an ordinary
 * OPERATIONS user to test with. Nothing in the product could repair them.
 *
 * The value is taken from the creator's own record and never from the request body. That
 * direction matters as much as the value: `CreateUserDto` has no `organizationId` field, the
 * global pipe runs `forbidNonWhitelisted`, and a client that tries to name its own organisation
 * is refused with a 400. These tests pin both halves — that the organisation is inherited, and
 * that it comes from the creator rather than from anything the caller sent.
 */
describe('UserService.createUser — organisation inheritance', () => {
  let service: UserService;

  const ORG = 'a0000000-0000-4000-a000-000000000001';
  const CREATOR = 'c0000000-0000-4000-c000-0000000000c1';

  const mockUserRepo = {
    findOne: jest.fn(),
    create: jest.fn((v: any) => v),
    save: jest.fn((v: any) => Promise.resolve({ ...v, id: 'new-user-id' })),
  };
  const mockRoleRepo = { find: jest.fn().mockResolvedValue([]) };
  const mockPermissionRepo = { find: jest.fn() };
  const mockAudit = { recordEvent: jest.fn().mockResolvedValue(undefined) };
  const mockEvents = { publish: jest.fn() };
  const mockCache = { del: jest.fn().mockResolvedValue(undefined) };

  const dto = {
    username: 'cert_new_operator',
    email: 'cert.new.operator@example.test',
    firstName: 'Cert',
    lastName: 'Operator',
    password: 'AStr0ngEnoughPassword!',
  } as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: mockUserRepo },
        { provide: getRepositoryToken(RoleEntity), useValue: mockRoleRepo },
        { provide: getRepositoryToken(PermissionEntity), useValue: mockPermissionRepo },
        { provide: AuditService, useValue: mockAudit },
        { provide: DomainEventPublisher, useValue: mockEvents },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();
    service = module.get<UserService>(UserService);
  });

  /** First call is the duplicate check (must miss), second is the creator lookup. */
  const withCreator = (organizationId: string | null) => {
    mockUserRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: CREATOR, organizationId });
  };

  it('gives the new account the creating administrator’s organisation', async () => {
    withCreator(ORG);

    await service.createUser(dto, CREATOR);

    expect(mockUserRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
  });

  it('reads the organisation from the creator’s record, not from anything the caller sent', async () => {
    withCreator(ORG);

    // A caller trying to name a different organisation: the pipe rejects this shape before the
    // service is ever reached in production, but if one did arrive it must still be ignored.
    await service.createUser({ ...dto, organizationId: 'b0000000-0000-4000-b000-000000000001' }, CREATOR);

    expect(mockUserRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
    // And the lookup that produced it was keyed on the creator, not on the body.
    expect(mockUserRepo.findOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: CREATOR } }),
    );
  });

  it('leaves the new account unassigned when the creator has no organisation, rather than inventing one', async () => {
    // The pre-existing orphan case. Propagating null is honest; guessing an organisation here
    // would quietly put someone in a company they were never added to, and that is worse than
    // the 403 the orphan already gets — which is at least visible and repairable by migration.
    withCreator(null);

    await service.createUser(dto, CREATOR);

    expect(mockUserRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: null }),
    );
  });
});
