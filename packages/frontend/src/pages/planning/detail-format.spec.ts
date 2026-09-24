import { feeLabel, ratingLabel } from './detail-format';

describe('assayer detail numbers (W4/W5/W7)', () => {
  it('shows an unrated person as "—", never 0.0', () => {
    expect(ratingLabel(null)).toBe('—');
    expect(ratingLabel(undefined)).toBe('—');
    expect(ratingLabel('')).toBe('—');
    expect(ratingLabel('4.50')).toBe('4.5');
    expect(ratingLabel(0)).toBe('0.0');
  });

  it('formats fees as rupees with Indian grouping, and "—" when absent', () => {
    expect(feeLabel(125000)).toBe('₹1,25,000');
    expect(feeLabel('1500.00')).toBe('₹1,500');
    expect(feeLabel(null)).toBe('—');
  });
});
