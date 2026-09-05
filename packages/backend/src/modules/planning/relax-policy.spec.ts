import { ClientEligibilityFilter } from './recommendation.engine';

/**
 * The two policy toggles the planning screen now offers, at the level where they actually decide
 * something.
 *
 * Both are "show me more", not "let me do more": the standing is still computed and still travels
 * to the card, and `AssignmentService` still refuses to create the assignment without a recorded
 * reason. What they change is whether a compliance-strict list is an empty one — on this estate
 * more than half the active workforce has no Active or Recommended standing with any client, and
 * an empty candidate list gets worked around outside the system rather than inside it.
 */
describe('ClientEligibilityFilter — “also show people not on this client’s panel”', () => {
  const filter = () => {
    const f: any = Object.create(ClientEligibilityFilter.prototype);
    f.ruleBypass = { isBypassedSync: jest.fn().mockReturnValue(false), noteBypass: jest.fn() };
    f.platformSettings = { get: jest.fn().mockResolvedValue('BLOCK') };
    return f;
  };

  const context = (over: Record<string, unknown> = {}) => ({
    client: { id: 'c-1', clientCode: 'AXIS' },
    branchFacts: { empanelmentStatusByAssayer: {} },
    ...over,
  });

  const assayer = { id: 'a-1', displayName: 'Ravi Kumar' } as any;

  it('excludes an unempanelled person when the rule is on, as it always did', async () => {
    expect(await filter().evaluate(assayer, context())).toBe(false);
  });

  it('keeps them when the operator asks to see past the panel', async () => {
    expect(await filter().evaluate(assayer, context({ relaxClientEligibility: true }))).toBe(true);
  });

  /**
   * Relaxed is not ignored. The reason is still computed so the card can print it — a longer list
   * with no way to tell which names are on it legitimately would be worse than the short one.
   */
  it('still knows why they would have been excluded, so the row can say so', async () => {
    const reason = await filter().exclusionReason(assayer, context({ relaxClientEligibility: true }));
    expect(reason).toMatch(/no empanelment record/i);
  });

  /**
   * A negative standing is a different thing from an absent one, and the toggle covers both —
   * deliberately: the operator asked to see the people this client's panel excludes, and being
   * told "REJECTED by AXIS" on the card is exactly the information that makes that decision.
   */
  it('shows a person whose standing is negative, with the standing named', async () => {
    const ctx = context({
      relaxClientEligibility: true,
      branchFacts: { empanelmentStatusByAssayer: { 'a-1': 'REJECTED' } },
    });
    expect(await filter().evaluate(assayer, ctx)).toBe(true);
    expect(await filter().exclusionReason(assayer, ctx)).toMatch(/REJECTED/);
  });
});
