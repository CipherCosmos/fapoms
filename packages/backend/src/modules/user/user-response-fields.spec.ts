import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { UserController } from './user.controller';
import { UserEntity } from './user.entity';

/**
 * WHAT A USER RESPONSE MAY CARRY.
 *
 * `GET /users/me` and `GET /users` returned the whole row minus the password hash — including the
 * hash of a live set-password link (which, until spent, IS a password) and its expiry. `/users/me`
 * also handed the account holder's browser the lockout counters, which it caches for the session.
 */
describe('user responses leave out credential and lockout internals', () => {
  const row = {
    id: 'u-1', username: 'meera', email: 'm@example.com', status: 'ACTIVE',
    passwordHash: '$2b$12$x', passwordSetupTokenHash: 'a'.repeat(64),
    passwordSetupExpiresAt: new Date('2099-01-01'), failedLoginAttempts: 3,
    lockedUntil: new Date('2099-01-01'),
  };
  const userService = {
    findAll: jest.fn(async () => ({ users: [row], total: 1 })),
    findById: jest.fn(async () => row),
    updateUser: jest.fn(async () => row),
  };
  const controller = new UserController(userService as any);

  const SECRET = ['passwordHash', 'passwordSetupTokenHash', 'passwordSetupExpiresAt'];
  const LOCKOUT = ['failedLoginAttempts', 'lockedUntil'];

  it('GET /users/me: no secret, no lockout counters', () => {
    const me = controller.getMe({ user: row }) as any;
    for (const k of [...SECRET, ...LOCKOUT]) expect(me).not.toHaveProperty(k);
    expect(me).toMatchObject({ id: 'u-1', username: 'meera' });
  });

  it('PUT /users/me: same as GET', async () => {
    const me = (await controller.updateMe({} as any, { user: { id: 'u-1' } })) as any;
    for (const k of [...SECRET, ...LOCKOUT]) expect(me).not.toHaveProperty(k);
  });

  it('GET /users (admin directory): no secret; lock state kept for the administrator', async () => {
    const res: any = await controller.findAll(1, 20);
    for (const k of SECRET) expect(res.data[0]).not.toHaveProperty(k);
    expect(res.data[0]).toMatchObject({ failedLoginAttempts: 3 });
  });

  it('GET /users/:id: no secret', async () => {
    const u = (await controller.findOne('u-1')) as any;
    for (const k of SECRET) expect(u).not.toHaveProperty(k);
  });

  it('the set-password hash does not load on an ordinary read (select:false)', () => {
    const col = getMetadataArgsStorage().columns.find(
      (c) => c.target === UserEntity && c.propertyName === 'passwordSetupTokenHash',
    );
    expect(col?.options.select).toBe(false);
  });
});
