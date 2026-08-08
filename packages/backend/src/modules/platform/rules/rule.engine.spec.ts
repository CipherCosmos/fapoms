import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RuleEngine } from './rule.engine';
import { BusinessRuleEntity } from './business-rule.entity';

/**
 * Business rules are the configurable half of eligibility, so a rule that silently never fires
 * is worse than no rule at all — an operator believes a control is in place when it is not.
 */
describe('RuleEngine', () => {
  let engine: RuleEngine;

  const mockRuleRepository = { find: jest.fn() };

  const AUDIT_DATE = new Date('2026-08-20');

  const contextWith = (overrides: any = {}) => ({
    subject: {
      id: 'as-1',
      certifications: [],
      skills: [],
      ...overrides.subject,
    },
    target: { id: 'b-1', clientId: 'client-1', ...overrides.target },
    scheduledDate: AUDIT_DATE,
    activeWorkload: overrides.activeWorkload ?? 0,
  }) as any;

  const capacityRule = (conditions: Record<string, any>) => ({
    id: 'r-1',
    name: 'Capacity',
    ruleType: 'CAPACITY',
    scope: 'GLOBAL',
    isActive: true,
    conditions,
    action: { type: 'BLOCK' },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RuleEngine,
        { provide: getRepositoryToken(BusinessRuleEntity), useValue: mockRuleRepository },
      ],
    }).compile();

    engine = module.get(RuleEngine);
    jest.clearAllMocks();
  });

  describe('CAPACITY rules', () => {
    /**
     * The engine read `cond.maxWeeklyCapacity` only, while the rule actually stored in the
     * database expressed its limit as `maxConcurrent`. That rule could be switched on and would
     * still never block anybody.
     */
    it.each([
      ['maxWeeklyCapacity', { maxWeeklyCapacity: 5 }],
      ['maxConcurrent', { maxConcurrent: 5 }],
      ['maxConcurrentAssignments', { maxConcurrentAssignments: 5 }],
    ])('applies a limit written as %s', async (_label, conditions) => {
      mockRuleRepository.find.mockResolvedValue([capacityRule(conditions)]);

      const [result] = await engine.evaluate(contextWith({ activeWorkload: 5 }));

      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/Open assignments \(5\) reached the limit of 5/);
    });

    it('permits an assayer who is still below the limit', async () => {
      mockRuleRepository.find.mockResolvedValue([capacityRule({ maxConcurrent: 5 })]);

      const [result] = await engine.evaluate(contextWith({ activeWorkload: 4 }));

      expect(result.passed).toBe(true);
    });

    it('does nothing when the rule carries no limit at all', async () => {
      mockRuleRepository.find.mockResolvedValue([capacityRule({})]);

      const [result] = await engine.evaluate(contextWith({ activeWorkload: 99 }));

      expect(result.passed).toBe(true);
    });
  });

  describe('CERTIFICATION rules', () => {
    const certRule = {
      id: 'r-2',
      name: 'Gold cert',
      ruleType: 'CERTIFICATION',
      scope: 'GLOBAL',
      isActive: true,
      conditions: { requiredCertification: 'Gold Assaying' },
      action: { type: 'BLOCK' },
    };

    it('rejects a certification that has lapsed by the audit date', async () => {
      mockRuleRepository.find.mockResolvedValue([certRule]);

      const [result] = await engine.evaluate(
        contextWith({ subject: { certifications: [{ name: 'Gold Assaying', expiryDate: '2026-07-01' }] } }),
      );

      expect(result.passed).toBe(false);
    });

    it('accepts one still valid on that date', async () => {
      mockRuleRepository.find.mockResolvedValue([certRule]);

      const [result] = await engine.evaluate(
        contextWith({ subject: { certifications: [{ name: 'Gold Assaying', expiryDate: '2027-01-01' }] } }),
      );

      expect(result.passed).toBe(true);
    });
  });
});
