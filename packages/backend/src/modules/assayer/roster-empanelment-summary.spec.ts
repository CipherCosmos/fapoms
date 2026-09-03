import { PLANNABLE_EMPANELMENT_STANDINGS, EmpanelmentStatus } from '@fapoms/shared';
import { AssayerService } from './assayer.service';

/**
 * The roster row says whether this person can be sent to any client at all.
 *
 * `ClientEligibilityFilter` admits only ACTIVE and RECOMMENDED standings, and blocks a candidate
 * with no row for the client. The roster carried no empanelment data whatsoever, so a screen could
 * show a complete, ACTIVE assayer with every document verified and no way to say the planner will
 * never offer them anything — which is true of 245 of the 548 active people on the live roster.
 *
 * The distinction these tests exist for is `clientCount` vs `plannableClients`. Counting rows
 * would make a REJECTED person look empanelled; counting only qualifying rows loses "vetted by
 * four banks, cleared by none", which is the case a vetting desk most needs to see. So both.
 */
describe('the empanelment summary on a roster row', () => {
  const hydrate = async (rowsFromDb: any[]) => {
    const svc: any = Object.create(AssayerService.prototype);
    svc.assayerRepository = { manager: { query: jest.fn().mockResolvedValue(rowsFromDb) } };
    const people = [{ id: 'a1' }, { id: 'a2' }] as any[];
    await svc.hydrateEmpanelmentSummary(people, ['a1', 'a2']);
    return people as any[];
  };

  it('reports zero for somebody with no standing anywhere', async () => {
    // Zeros, not an absent key: this is the most important case of the query, not an exception.
    const [a1] = await hydrate([]);
    expect(a1.empanelment).toEqual({ clientCount: 0, plannableClients: 0 });
  });

  it('separates "vetted by a client" from "cleared by one"', async () => {
    const [a1] = await hydrate([{ assayer_id: 'a1', clients: 4, plannable: 0 }]);

    expect(a1.empanelment.clientCount).toBe(4);
    expect(a1.empanelment.plannableClients).toBe(0);
  });

  it('counts a person the planner will actually offer work to', async () => {
    const [, a2] = await hydrate([{ assayer_id: 'a2', clients: 3, plannable: 2 }]);
    expect(a2.empanelment).toEqual({ clientCount: 3, plannableClients: 2 });
  });

  it('asks the database for exactly the standings the planner admits', async () => {
    // The filter is passed as a parameter from `@fapoms/shared`, not written into the SQL, so this
    // count and the planning gate cannot drift. If a standing is ever added to the shared list,
    // this query includes it with no edit here.
    const svc: any = Object.create(AssayerService.prototype);
    const query = jest.fn().mockResolvedValue([]);
    svc.assayerRepository = { manager: { query } };
    await svc.hydrateEmpanelmentSummary([{ id: 'a1' }], ['a1']);

    const [, params] = query.mock.calls[0];
    expect(params[1]).toEqual([...PLANNABLE_EMPANELMENT_STANDINGS]);
    expect(params[1]).toContain(EmpanelmentStatus.ACTIVE);
    expect(params[1]).toContain(EmpanelmentStatus.RECOMMENDED);
    expect(params[1]).not.toContain(EmpanelmentStatus.DOCUMENTS_PENDING);
  });

  it('does not query at all for an empty page', async () => {
    const svc: any = Object.create(AssayerService.prototype);
    const query = jest.fn();
    svc.assayerRepository = { manager: { query } };
    await svc.hydrateEmpanelmentSummary([], []);
    expect(query).not.toHaveBeenCalled();
  });
});
