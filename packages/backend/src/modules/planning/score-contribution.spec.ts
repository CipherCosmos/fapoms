/**
 * What a recommendation card is allowed to call "the reason".
 *
 * The engine scores seventeen dimensions 0–100 and then weights them. A raw score says how the
 * candidate did; it says nothing about how much that dimension counted. The card used to
 * explain a match by the highest raw scores, so dimensions weighted at zero led the sentence —
 * `customerDensity` returns ~100 for nearly everyone and is weighted 0.00, and was routinely
 * quoted as the reason for a ranking it had no part in.
 *
 * This pins the arithmetic the engine now sends alongside the breakdown: points contributed,
 * summing to the final score.
 */
describe('score contribution', () => {
  /** The engine's own calculation, in miniature — see RecommendationEngine.recommend. */
  const contributionsFor = (
    scores: Record<string, number>,
    weights: Record<string, number>,
  ): { contribution: Record<string, number>; finalScore: number } => {
    let weightedSum = 0;
    let totalWeight = 0;
    for (const [name, score] of Object.entries(scores)) {
      const w = weights[name] ?? 0;
      weightedSum += score * w;
      totalWeight += w;
    }
    const finalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const contribution: Record<string, number> = {};
    for (const [name, score] of Object.entries(scores)) {
      contribution[name] = totalWeight > 0
        ? parseFloat(((score * (weights[name] ?? 0)) / totalWeight).toFixed(2))
        : 0;
    }
    return { contribution, finalScore };
  };

  it('gives a zero-weight dimension no contribution, however high it scores', () => {
    const { contribution } = contributionsFor(
      { customerDensity: 100, distance: 40 },
      { customerDensity: 0, distance: 0.14 },
    );
    // The whole defect: 100 out of 100, and it moved the ranking by nothing.
    expect(contribution.customerDensity).toBe(0);
    expect(contribution.distance).toBeGreaterThan(0);
  });

  it('ranks a heavily-weighted middling score above a weightless perfect one', () => {
    const { contribution } = contributionsFor(
      { customerDensity: 100, slaCompliance: 62 },
      { customerDensity: 0, slaCompliance: 0.15 },
    );
    const ranked = Object.entries(contribution).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    expect(ranked[0]).toBe('slaCompliance');
  });

  it('contributions add up to the score the card shows', () => {
    const scores = { distance: 80, slaCompliance: 60, workload: 40, performance: 100 };
    const weights = { distance: 0.14, slaCompliance: 0.15, workload: 0.1, performance: 0.07 };
    const { contribution, finalScore } = contributionsFor(scores, weights);

    const summed = Object.values(contribution).reduce((a, b) => a + b, 0);
    expect(summed).toBeCloseTo(finalScore, 1);
  });

  it('reports nothing rather than dividing by zero when every weight is off', () => {
    const { contribution, finalScore } = contributionsFor({ distance: 80 }, { distance: 0 });
    expect(finalScore).toBe(0);
    expect(contribution.distance).toBe(0);
  });
});
