import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as xlsx from 'xlsx';

import { ReportsService } from './reports.service';
import { AssignmentService } from '../assignment/assignment.service';
import { BillingEngineService } from '../billing-engine/billing-engine.service';
import { CommandCenterService } from '../planning/command-center.service';
import { AssayerService } from '../assayer/assayer.service';
import { ProjectQueryService } from '../project/project-query.service';
import { AssayerEntity } from '../assayer/assayer.entity';

/** Reads a workbook Buffer back into `{ [sheetName]: row[][] }`, header row included. */
function readSheets(buffer: Buffer): Record<string, unknown[][]> {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const out: Record<string, unknown[][]> = {};
  for (const name of wb.SheetNames) {
    out[name] = xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null }) as unknown[][];
  }
  return out;
}

describe('ReportsService', () => {
  let service: ReportsService;

  const assignmentService = { findAll: jest.fn() };
  const billingService = { listClientLines: jest.fn(), findInvoices: jest.fn() };
  const commandCenterService = { overview: jest.fn() };
  const assayerService = { findAll: jest.fn(), getRosterCommercialProfiles: jest.fn() };
  const projectQueryService = { findProjectBranches: jest.fn(), findOne: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: AssignmentService, useValue: assignmentService },
        { provide: BillingEngineService, useValue: billingService },
        { provide: CommandCenterService, useValue: commandCenterService },
        { provide: AssayerService, useValue: assayerService },
        { provide: ProjectQueryService, useValue: projectQueryService },
        { provide: getRepositoryToken(AssayerEntity), useValue: {} },
      ],
    }).compile();

    service = module.get(ReportsService);
    jest.clearAllMocks();
  });

  describe('assayerRoster — Pay Roll sheet scope', () => {
    /**
     * Regression for the live bug found 2026-09-04: `getRosterCommercialProfiles()` takes no
     * scope (it is one query across every active assayer in the org, by its own contract), so
     * mapping over its full result unconditionally put every OTHER assayer's real commercial
     * figures — base fee, daily rate, allowances — into a regionally-scoped caller's export, as
     * a blank-named row (the roster lookup for that id legitimately finding nothing). Confirmed
     * live: a SOUTH-scoped OPERATIONS account got a 395-row Roster sheet next to a 1,164-row Pay
     * Roll sheet — every out-of-region row unnamed but carrying real pay figures.
     */
    it('never puts a commercial profile in the Pay Roll sheet for an assayer outside the caller-scoped Roster sheet', async () => {
      // Only two assayers are "in scope" (as if findAll(..., scope) already applied a region
      // filter) — IN_SCOPE_1 has a profile, IN_SCOPE_2 does not.
      assayerService.findAll.mockResolvedValue({
        assayers: [
          { id: 'in-scope-1', assayerCode: 'AS-01', displayName: 'In Scope One' },
          { id: 'in-scope-2', assayerCode: 'AS-02', displayName: 'In Scope Two' },
        ],
      });
      // The real `getRosterCommercialProfiles()` returns one entry per ACTIVE ASSAYER IN THE
      // WHOLE SYSTEM, unconditionally — including a null-profile entry for one with no rate
      // card, and (this is the leak) entries for assayers outside any caller's scope entirely.
      assayerService.getRosterCommercialProfiles.mockResolvedValue([
        {
          assayerId: 'in-scope-1',
          profile: { baseFee: 1500, dailyRate: 3800, effectiveStartDate: '2026-01-01' },
          hasFutureProfile: false,
        },
        { assayerId: 'in-scope-2', profile: null, hasFutureProfile: false },
        {
          assayerId: 'out-of-scope-3',
          profile: { baseFee: 1400, dailyRate: 3600, effectiveStartDate: '2026-01-01' },
          hasFutureProfile: false,
        },
      ]);

      const buffer = await service.assayerRoster({ roles: ['ADMIN'] }, {});
      const sheets = readSheets(buffer);

      // Roster sheet: header + the 2 in-scope assayers, nothing else.
      expect(sheets['Roster']).toHaveLength(3);

      // Pay Roll sheet: header + exactly 2 data rows (one per in-scope assayer) — the
      // out-of-scope profile must not appear as a row at all, named or not.
      const payRollRows = sheets['Pay Roll'].slice(1);
      expect(payRollRows).toHaveLength(2);

      const codes = payRollRows.map((r) => r[0]);
      expect(codes.sort()).toEqual(['AS-01', 'AS-02']);

      // No row anywhere in the Pay Roll sheet has a blank name/code — the tell-tale shape of the
      // bug (a real figure attached to nobody the caller is allowed to see).
      for (const row of payRollRows) {
        expect(row[0]).not.toBeNull();
        expect(row[1]).not.toBeNull();
      }

      // The one in-scope profile still carries its real figures, unaffected by the fix.
      const inScopeRow = payRollRows.find((r) => r[0] === 'AS-01')!;
      expect(inScopeRow[2]).toBe(1500); // baseFee
      expect(inScopeRow[11]).toBe('IN_FORCE');

      // The in-scope assayer with no profile still gets its NO_PROFILE row (the fix must not
      // also drop legitimately-in-scope assayers who simply have no rate card yet).
      const noProfileRow = payRollRows.find((r) => r[0] === 'AS-02')!;
      expect(noProfileRow[11]).toBe('NO_PROFILE');
    });

    it('keeps every profile when the caller is unrestricted (no scope narrowing happened upstream)', async () => {
      assayerService.findAll.mockResolvedValue({
        assayers: [
          { id: 'a-1', assayerCode: 'AS-01', displayName: 'One' },
          { id: 'a-2', assayerCode: 'AS-02', displayName: 'Two' },
        ],
      });
      assayerService.getRosterCommercialProfiles.mockResolvedValue([
        { assayerId: 'a-1', profile: { baseFee: 1000 }, hasFutureProfile: false },
        { assayerId: 'a-2', profile: { baseFee: 2000 }, hasFutureProfile: false },
      ]);

      const buffer = await service.assayerRoster({ roles: ['ADMIN'] }, {});
      const sheets = readSheets(buffer);
      expect(sheets['Pay Roll'].slice(1)).toHaveLength(2);
    });
  });

  describe('coverage — nonexistent vs. genuinely empty project', () => {
    /**
     * Regression for the live bug found 2026-09-04: `findProjectBranches` is a plain `.find()`
     * with no existence check, so a bogus project id and a real project with zero branches both
     * came back `[]` — the endpoint returned 200 with a "0 branches, 0% coverage" workbook for a
     * project id that does not exist at all.
     */
    it('propagates NotFoundException for a project id that does not exist', async () => {
      projectQueryService.findProjectBranches.mockResolvedValue([]);
      projectQueryService.findOne.mockRejectedValue(new NotFoundException('Project bogus-id not found.'));

      await expect(service.coverage('bogus-id')).rejects.toThrow(NotFoundException);
    });

    it('still produces a valid empty workbook for a real project that genuinely has zero branches', async () => {
      projectQueryService.findProjectBranches.mockResolvedValue([]);
      projectQueryService.findOne.mockResolvedValue({ id: 'real-empty-project' });

      const buffer = await service.coverage('real-empty-project');
      const sheets = readSheets(buffer);

      expect(sheets['Summary'][1]).toEqual([0, 0, 0, 0, 0, 0]);
      // `buildWorkbook` deliberately writes one all-blank placeholder row under the header for
      // an empty sheet (so Excel doesn't collapse it to columnless) — header + that placeholder,
      // and critically no real data row, no error.
      expect(sheets['Branch Coverage']).toHaveLength(2);
      expect(sheets['Branch Coverage'][1].every((cell) => cell === null)).toBe(true);
    });

    it('does not pay the extra existence-check query when branches are non-empty', async () => {
      projectQueryService.findProjectBranches.mockResolvedValue([
        { status: 'PLANNING', assignments: [], branch: {} },
      ]);

      await service.coverage('real-project-with-branches');

      expect(projectQueryService.findOne).not.toHaveBeenCalled();
    });
  });
});
