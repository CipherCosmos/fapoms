import { getMetadataArgsStorage } from 'typeorm';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { ResponsibilityEntity } from './responsibility.entity';
import { CapabilityEntity } from './capability.entity';

/**
 * The RBAC relations (user->roles, role->permissions, role->responsibilities,
 * responsibility->capabilities, capability->permissions) used to be `eager: true`, so every
 * ordinary read of a user or role pulled the full five-way join whether or not the caller
 * wanted it. Measured: GET /users page of 6 returned 6,074 rows / 7.1 MB; a principal-cache
 * miss for an admin pulled 2,142 rows / 2.5 MB. Every caller that actually needs roles now says
 * so explicitly via `relations: [...]` (see auth.service.ts and user.service.ts) — this spec
 * guards the entity side of that: nobody should be able to re-add `eager: true` without a test
 * failing here.
 */
describe('RBAC relations are not eager-loaded', () => {
  function relationOptions(target: Function, propertyName: string): any {
    const relation = getMetadataArgsStorage().relations.find(
      (r) => r.target === target && r.propertyName === propertyName,
    );
    if (!relation) throw new Error(`No relation metadata found for ${target.name}.${propertyName}`);
    const options = relation.options as unknown;
    return typeof options === 'function' ? (options as () => any)() : options;
  }

  it('UserEntity.roles is not eager', () => {
    expect(relationOptions(UserEntity, 'roles')?.eager).not.toBe(true);
  });

  it('RoleEntity.permissions is not eager', () => {
    expect(relationOptions(RoleEntity, 'permissions')?.eager).not.toBe(true);
  });

  it('RoleEntity.responsibilities is not eager', () => {
    expect(relationOptions(RoleEntity, 'responsibilities')?.eager).not.toBe(true);
  });

  it('ResponsibilityEntity.capabilities is not eager', () => {
    expect(relationOptions(ResponsibilityEntity, 'capabilities')?.eager).not.toBe(true);
  });

  it('CapabilityEntity.permissions is not eager', () => {
    expect(relationOptions(CapabilityEntity, 'permissions')?.eager).not.toBe(true);
  });
});
