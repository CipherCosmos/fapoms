import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Priority, ProjectStatus } from '@fapoms/shared';
import { CreateProjectRequestDto, UpdateProjectRequestDto } from './project.controller';

/**
 * `priority`/`status` on the project DTOs used to be bare `@IsString()`. `Projects.tsx`'s own
 * dropdowns only ever send a real `Priority`/`ProjectStatus` enum member — confirmed below by
 * reading its actual call sites — but a direct/malformed API call could send anything, and
 * `riskScoreFromCategory` (project.service.ts ~line 123) silently falls through to LOW risk for
 * any priority string it does not recognise. This pins the boundary down to the real enums.
 *
 * `UpdateProjectRequestDto` has no `status` field at all (status changes go exclusively through
 * `POST /projects/:id/transition`'s own DTO, confirmed by grepping the frontend for any PUT
 * that sends `status`), so there is nothing to tighten there — only `priority` is checked below.
 */
// A real UUID shape, not just 32 hex digits with dashes: class-validator's default `@IsUUID()`
// checks the version/variant nibbles too, so an all-"1" placeholder fails it (variant nibble
// must be 8/9/a/b). This is version 4, variant "8" — a valid UUID by that check.
const VALID_CLIENT_ID = '11111111-1111-4111-8111-111111111111';

function createDto(overrides: Partial<Record<'priority' | 'status', unknown>> = {}) {
  return plainToInstance(CreateProjectRequestDto, {
    name: 'Q3 branch audit',
    clientId: VALID_CLIENT_ID,
    priority: Priority.MEDIUM,
    ...overrides,
  });
}

function updateDto(overrides: Partial<Record<'priority', unknown>> = {}) {
  return plainToInstance(UpdateProjectRequestDto, { ...overrides });
}

describe('CreateProjectRequestDto.priority', () => {
  it.each(Object.values(Priority))('accepts the real Priority member %s', async (priority) => {
    const errors = await validate(createDto({ priority }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage priority string', async () => {
    const errors = await validate(createDto({ priority: 'SUPER_URGENT' }));
    expect(errors.some((e) => e.property === 'priority' && e.constraints?.isEnum)).toBe(true);
  });
});

describe('CreateProjectRequestDto.status', () => {
  it.each(Object.values(ProjectStatus))('accepts the real ProjectStatus member %s', async (status) => {
    const errors = await validate(createDto({ status }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an absent status — never actually read by ProjectService.create', async () => {
    const errors = await validate(createDto());
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage status string', async () => {
    const errors = await validate(createDto({ status: 'IN_LIMBO' }));
    expect(errors.some((e) => e.property === 'status' && e.constraints?.isEnum)).toBe(true);
  });
});

describe('UpdateProjectRequestDto.priority', () => {
  it('stays optional — an edit touching other fields sends no priority', async () => {
    const errors = await validate(updateDto());
    expect(errors).toHaveLength(0);
  });

  it.each(Object.values(Priority))('accepts the real Priority member %s when present', async (priority) => {
    const errors = await validate(updateDto({ priority }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage priority string on update', async () => {
    const errors = await validate(updateDto({ priority: 'WHENEVER' }));
    expect(errors.some((e) => e.property === 'priority' && e.constraints?.isEnum)).toBe(true);
  });
});
