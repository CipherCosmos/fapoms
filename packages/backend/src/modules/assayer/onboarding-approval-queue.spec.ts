import { OnboardingApprovalEventKind as K, OnboardingApprovalStatus as S, Region } from '@fapoms/shared';
import { OnboardingApprovalController } from './onboarding-approval.controller';
import { OnboardingApprovalService } from './onboarding-approval.service';
import { AssayerOnboardingApprovalEntity } from './assayer-onboarding-approval.entity';
import { AssayerEntity } from './assayer.entity';
import { RegionGuardService } from '../../infrastructure/scope/region-guard.service';

/**
 * THE APPROVER'S LIST — who is waiting for a decision before training.
 *
 * It is what the "Approvals" page and its count in the navigation read, so two things about it
 * matter more than anywhere else: it must carry what the screen needs to tell "yours to decide"
 * from "you prepared this, so somebody else decides" (the round's preparers, the same list the
 * decision itself is refused on), and it must be held to the reader's regions like every other
 * approval route — a regional approver shown a joiner they are then refused on opening is a list
 * that lies.
 */
describe('the approval queue', () => {
  const HR = 'hr-1';
  const round = (id: string, assayerId: string, status: S, createdAt: string, events: unknown[] = []) => ({
    id, assayerId, round: 1, status, submittedBy: HR, decidedBy: null, decidedAt: null, createdAt,
    events: [{ kind: K.SUBMITTED, byId: HR, byName: 'Asha (HR)', at: createdAt, text: 'All checks clear.' }, ...events],
  });

  const service = (rounds: any[], people: any[]) => {
    const manager = {
      getRepository: (entity: unknown) => ({
        find: jest.fn(async ({ where }: any) => {
          if (entity === AssayerOnboardingApprovalEntity) {
            const open = (Array.isArray(where) ? where : [where]).map((w: any) => w.status);
            return rounds.filter((r) => open.includes(r.status))
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          }
          if (entity === AssayerEntity) {
            const ids = (Array.isArray(where) ? where : [where]).map((w: any) => w.id);
            return people.filter((p) => ids.includes(p.id) && p.isActive !== false);
          }
          return [];
        }),
      }),
      query: jest.fn(async () => []),
    };
    const unitOfWork = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
    return new OnboardingApprovalService({} as never, {} as never, unitOfWork as never);
  };

  const guard = new RegionGuardService({} as never, {} as never);

  const people = [
    { id: 'a-west', displayName: 'West Joiner', assayerCode: 'AS-W', region: Region.WEST },
    { id: 'a-south', displayName: 'South Joiner', assayerCode: 'AS-S', region: Region.SOUTH },
    { id: 'a-none', displayName: 'Unplaced Joiner', assayerCode: null, region: null },
  ];
  const rounds = [
    round('r-west', 'a-west', S.PENDING, '2026-09-20T09:00:00Z'),
    round('r-south', 'a-south', S.INFO_REQUESTED, '2026-09-21T09:00:00Z'),
    round('r-none', 'a-none', S.PENDING, '2026-09-22T09:00:00Z'),
    round('r-done', 'a-west', S.APPROVED, '2026-09-01T09:00:00Z'),
  ];

  it('lists every open round, oldest first, with who prepared it and where the person is', async () => {
    const rows = await service(rounds, people).queue();

    expect(rows.map((r) => r.assayerId)).toEqual(['a-west', 'a-south', 'a-none']);
    expect(rows[0]).toMatchObject({
      displayName: 'West Joiner', assayerCode: 'AS-W', region: Region.WEST, status: S.PENDING,
      // The people who may not decide it — what the page splits "yours" from "someone else's" on.
      preparers: [HR],
    });
    // A decided round is not waiting on anybody.
    expect(rows.find((r) => r.id === 'r-done')).toBeUndefined();
  });

  describe('held to the reader\'s regions', () => {
    const controller = (rows: any[]) => new OnboardingApprovalController(
      { queue: jest.fn(async () => rows) } as never,
      guard,
    );

    it('shows a national approver everybody', async () => {
      const rows = await service(rounds, people).queue();
      const listed = await controller(rows).queue({ regions: null });
      expect(listed.map((r: any) => r.assayerId)).toEqual(['a-west', 'a-south', 'a-none']);
    });

    it('shows a regional approver their own region, and nobody from another', async () => {
      const rows = await service(rounds, people).queue();
      const listed = await controller(rows).queue({ regions: [Region.WEST] });
      expect(listed.map((r: any) => r.assayerId)).not.toContain('a-south');
      expect(listed.map((r: any) => r.assayerId)).toContain('a-west');
    });

    /**
     * Somebody whose region was never recorded is a data gap, not a boundary — the same rule the
     * record applies when it is opened, so the list and the record agree.
     */
    it('still shows somebody whose region was never recorded', async () => {
      const rows = await service(rounds, people).queue();
      const listed = await controller(rows).queue({ regions: [Region.WEST] });
      expect(listed.map((r: any) => r.assayerId)).toContain('a-none');
    });

    it('lists exactly who the record would let them open', async () => {
      const rows = await service(rounds, people).queue();
      const scope = { regions: [Region.WEST] };
      const listed = new Set((await controller(rows).queue(scope)).map((r: any) => r.assayerId));
      for (const r of rows) {
        const opens = (() => { try { guard.assertRegionAllowed(r.region, scope); return true; } catch { return false; } })();
        expect(listed.has(r.assayerId)).toBe(opens);
      }
    });
  });
});
