import { RosterImportService } from './roster-import.service';
import type { RosterImportSummary } from './roster-import.service';

/**
 * The importer's client resolver: how a bank name written in the roster becomes a client id —
 * reusing an existing client whenever one plausibly matches, creating a minimal stub when none
 * does, and refusing to guess when two could be meant. This is the dedup contract the auto-
 * creation feature stands on: years of hand-typed data must never mint a duplicate client or
 * silently merge two banks.
 */
describe('roster import — client resolution and auto-creation', () => {
  const makeManager = (clients: Array<{ id: string; name: string; displayName?: string }>, codes: string[] = []) => {
    const saved: any[] = [];
    let n = 1;
    return {
      saved,
      find: async (_entity: any, q: any) =>
        q?.withDeleted
          ? [...codes, ...saved.map((s) => s.clientCode)].map((c) => ({ clientCode: c }))
          : clients,
      create: (_entity: any, obj: any) => ({ ...obj }),
      save: async (_entity: any, obj: any) => {
        if (obj.id == null) obj.id = `created-${n++}`;
        saved.push(obj);
        return obj;
      },
    };
  };

  const resolverOn = (service: RosterImportService, manager: any, autoCreate = true) =>
    (service as any).buildClientResolver(manager, autoCreate, 'user-1');

  const service = new RosterImportService({} as any, {} as any, {} as any);
  const freshSummary = (): RosterImportSummary =>
    ({ notes: [] }) as any;

  it('reuses an existing client on an exact or first-word match — "ICICI" finds "ICICI Bank Ltd"', async () => {
    const manager = makeManager([{ id: 'c-icici', name: 'ICICI Bank Ltd' }]);
    const clients = await resolverOn(service, manager);
    expect(await clients.resolve('ICICI')).toBe('c-icici');
    expect(manager.saved).toHaveLength(0);
  });

  it('reuses on word containment — "AU FINANCE" finds "AU Small Finance Bank"', async () => {
    const manager = makeManager([{ id: 'c-au', name: 'AU Small Finance Bank' }]);
    const clients = await resolverOn(service, manager);
    expect(await clients.resolve('AU FINANCE')).toBe('c-au');
    expect(manager.saved).toHaveLength(0);
  });

  it('two plausible existing clients = an ambiguity: nothing created, nothing linked, the note names both', async () => {
    const manager = makeManager([
      { id: 'c-1', name: 'Vistaar Financial Services' },
      { id: 'c-2', name: 'Vistaar Housing Finance' },
    ]);
    const clients = await resolverOn(service, manager);
    // Both existing clients open with "Vistaar", so the first-word shortcut refuses to pick
    // one and the containment tier sees both.
    expect(await clients.resolve('VISTAAR')).toBeNull();
    expect(manager.saved).toHaveLength(0);
    const summary = freshSummary();
    clients.flushNotes(summary, false);
    expect(summary.notes.join('\n')).toContain('matches more than one existing client');
    expect(summary.notes.join('\n')).toContain('Vistaar Financial Services');
    expect(summary.notes.join('\n')).toContain('Vistaar Housing Finance');
  });

  it('an unknown bank is created ONCE, later mentions reuse it, and the note counts the people linked', async () => {
    const manager = makeManager([], ['CL-0007']);
    const clients = await resolverOn(service, manager);
    const first = await clients.resolve('AXIS');
    const second = await clients.resolve('AXIS');
    expect(first).toBe(second);
    expect(manager.saved).toHaveLength(1);
    expect(manager.saved[0]).toMatchObject({
      name: 'AXIS',
      clientCode: 'CL-0008', // continues the existing series
      lifecycleStatus: 'ACTIVE',
    });
    expect(manager.saved[0].planningPreferences).toMatchObject({ rosterImportStub: true });
    const summary = freshSummary();
    clients.flushNotes(summary, false);
    expect(summary.notes[0]).toContain('Created client "AXIS" (CL-0008)');
    expect(summary.notes[0]).toContain('2 appraisers linked');
    expect(summary.notes[0]).toContain('complete its details');
  });

  it('a rehearsal phrases creation as "would" — the transaction rollback undoes the row itself', async () => {
    const manager = makeManager([]);
    const clients = await resolverOn(service, manager);
    await clients.resolve('IDFC');
    const summary = freshSummary();
    clients.flushNotes(summary, true);
    expect(summary.notes[0]).toContain('Would create client "IDFC"');
  });

  it('with auto-creation off, an unknown bank is only counted — the old behavior, verbatim', async () => {
    const manager = makeManager([]);
    const clients = await resolverOn(service, manager, false);
    expect(await clients.resolve('MUTHOOT')).toBeNull();
    expect(await clients.resolve('MUTHOOT')).toBeNull();
    expect(manager.saved).toHaveLength(0);
    const summary = freshSummary();
    clients.flushNotes(summary, false);
    expect(summary.notes[0]).toContain('2 appraisers carry a standing with "MUTHOOT"');
    expect(summary.notes[0]).toContain('automatic creation is off');
  });

  it('very short names never containment-match — "L&T" does not glue itself to another lender', async () => {
    // "L&T" normalises to "l t"; a containment tier that let two letters match would find it
    // inside half the directory. It must create its own client instead.
    const manager = makeManager([{ id: 'c-lakshmi', name: 'Lakshmi T Finance' }]);
    const clients = await resolverOn(service, manager);
    const id = await clients.resolve('L&T');
    expect(id).toBe(manager.saved[0]?.id);
    expect(manager.saved[0]?.name).toBe('L&T');
  });

  it('a created client is found by every later spelling that canonicalises to it', async () => {
    const manager = makeManager([]);
    const clients = await resolverOn(service, manager);
    const created = await clients.resolve('YES BANK');
    expect(await clients.resolve('yes bank')).toBe(created);
    expect(manager.saved).toHaveLength(1);
  });
});
