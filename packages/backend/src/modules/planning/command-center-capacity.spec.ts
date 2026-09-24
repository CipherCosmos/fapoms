import { readFileSync } from 'fs';
import { join } from 'path';
import { headcountCapacity, CAPACITY_WINDOW_WORKING_DAYS } from './command-center.service';

/**
 * F11 (owner decision 2026-09-25): Command Centre capacity is HEADCOUNT. One available assayer
 * supplies one assayer-day per working day; demand (already in assayer-days) is compared with
 * headcount × the working days in the capacity window. The per-assayer "most jobs per day" setting
 * it used to sum is gone.
 */
describe('Command Centre capacity is headcount-based', () => {
  it('one assayer is one assayer-day per working day, over a one-week window', () => {
    expect(CAPACITY_WINDOW_WORKING_DAYS).toBe(5);
    expect(headcountCapacity(4, 10)).toEqual({ dailyCapacity: 4, capacityAssayerDays: 20, loadRatio: 0.5 });
  });

  it('more demand than the window can clear reads above 1', () => {
    expect(headcountCapacity(2, 25).loadRatio).toBe(2.5);
  });

  it('no people means no ratio, not a division by zero', () => {
    expect(headcountCapacity(0, 12)).toEqual({ dailyCapacity: 0, capacityAssayerDays: 0, loadRatio: null });
  });

  it('never reads the removed per-day setting', () => {
    const source = readFileSync(join(__dirname, 'command-center.service.ts'), 'utf8');
    expect(source).not.toMatch(/max_daily_workload|maxDailyWorkload/);
  });
});
