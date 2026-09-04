import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateBusinessRuleRequestDto,
  UpdateBusinessRuleRequestDto,
  PlanningRuleType,
  PlanningRuleScope,
} from './planning.controller';

/**
 * `ruleType`/`scope` on the business-rule DTOs used to be bare `@IsString()`, accepting any
 * string a direct API call cared to send. `RuleEngine.evaluate` (rule.engine.ts) dispatches on
 * exactly `CERTIFICATION` / `SKILL` / `TERRITORY` / `CAPACITY`; anything else falls through every
 * branch of its switch and the rule silently never fires. `scope` is stored and later queried
 * against `GLOBAL` / `CLIENT` / `BRANCH` (`BusinessRuleEntity`'s own column comment). This pins
 * down that a garbage value is now rejected at the boundary and every real value the working
 * `Rules.tsx` form sends is still accepted.
 */
function createDto(overrides: Partial<Record<'name' | 'scope' | 'targetId' | 'ruleType' | 'conditions', unknown>> = {}) {
  return plainToInstance(CreateBusinessRuleRequestDto, {
    name: 'Skilled in gold assaying',
    scope: PlanningRuleScope.GLOBAL,
    ruleType: PlanningRuleType.SKILL,
    conditions: { requiredSkill: 'Gold assaying' },
    ...overrides,
  });
}

function updateDto(overrides: Partial<Record<'ruleType' | 'scope', unknown>> = {}) {
  return plainToInstance(UpdateBusinessRuleRequestDto, { ...overrides });
}

describe('CreateBusinessRuleRequestDto.ruleType', () => {
  it.each(Object.values(PlanningRuleType))('accepts the real engine rule type %s', async (ruleType) => {
    const errors = await validate(createDto({ ruleType }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage string, including the stale ELIGIBILITY the DTO comment used to name', async () => {
    const errors = await validate(createDto({ ruleType: 'ELIGIBILITY' }));
    expect(errors.some((e) => e.property === 'ruleType' && e.constraints?.isEnum)).toBe(true);
  });

  it('rejects an empty ruleType', async () => {
    const errors = await validate(createDto({ ruleType: '' }));
    expect(errors.some((e) => e.property === 'ruleType')).toBe(true);
  });
});

describe('CreateBusinessRuleRequestDto.scope', () => {
  // CLIENT/BRANCH need a real targetId alongside a real scope — see the targetId describe
  // block below for why. GLOBAL is the one scope that never takes one.
  it.each(Object.values(PlanningRuleScope))('accepts the real stored scope %s', async (scope) => {
    const targetId = scope === PlanningRuleScope.GLOBAL ? undefined : 'target-1';
    const errors = await validate(createDto({ scope, targetId }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage scope', async () => {
    const errors = await validate(createDto({ scope: 'NATIONAL', targetId: 'target-1' }));
    expect(errors.some((e) => e.property === 'scope' && e.constraints?.isEnum)).toBe(true);
  });
});

describe('CreateBusinessRuleRequestDto.targetId', () => {
  /**
   * `RuleEngine.loadRules` matches a CLIENT-scoped row on `targetId: clientId` and a
   * BRANCH-scoped one on `targetId: branch.id` — an exact match against a real id, never
   * against null. A CLIENT/BRANCH rule saved with no targetId cannot match any client or
   * branch, ever: it sits in the rules list looking exactly like a working rule (active, no
   * error) while silently doing nothing. Confirmed live: `POST /planning/rules` accepted
   * `{scope: 'BRANCH'}` with no targetId before this was added.
   */
  it.each([PlanningRuleScope.CLIENT, PlanningRuleScope.BRANCH])('rejects %s scope with no targetId', async (scope) => {
    const errors = await validate(createDto({ scope, targetId: undefined }));
    expect(errors.some((e) => e.property === 'targetId')).toBe(true);
  });

  it('rejects CLIENT/BRANCH scope with an empty-string targetId, not just a missing one', async () => {
    const errors = await validate(createDto({ scope: PlanningRuleScope.BRANCH, targetId: '' }));
    expect(errors.some((e) => e.property === 'targetId')).toBe(true);
  });

  it('does not require targetId for GLOBAL scope', async () => {
    const errors = await validate(createDto({ scope: PlanningRuleScope.GLOBAL, targetId: undefined }));
    expect(errors).toHaveLength(0);
  });
});

describe('UpdateBusinessRuleRequestDto.ruleType/scope', () => {
  it('stays optional — an update touching only conditions sends neither', async () => {
    const errors = await validate(updateDto());
    expect(errors).toHaveLength(0);
  });

  it.each(Object.values(PlanningRuleType))('accepts the real engine rule type %s when present', async (ruleType) => {
    const errors = await validate(updateDto({ ruleType }));
    expect(errors).toHaveLength(0);
  });

  it.each(Object.values(PlanningRuleScope))('accepts the real stored scope %s when present', async (scope) => {
    const errors = await validate(updateDto({ scope }));
    expect(errors).toHaveLength(0);
  });

  it('rejects a garbage ruleType on update', async () => {
    const errors = await validate(updateDto({ ruleType: 'NOT_A_RULE_TYPE' }));
    expect(errors.some((e) => e.property === 'ruleType' && e.constraints?.isEnum)).toBe(true);
  });

  it('rejects a garbage scope on update', async () => {
    const errors = await validate(updateDto({ scope: 'REGIONAL' }));
    expect(errors.some((e) => e.property === 'scope' && e.constraints?.isEnum)).toBe(true);
  });
});
