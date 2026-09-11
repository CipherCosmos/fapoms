import { DataSource, Repository } from 'typeorm';
import { AppDataSource } from '../../infrastructure/database/data-source';
import { BranchEntity } from './branch.entity';
import { BranchContactEntity } from './branch-contact.entity';
import { BranchDocumentEntity } from './branch-document.entity';
import { BranchQueryService } from './branch-query.service';
import { BranchService } from './branch.service';
import { ClientEntity } from '../client/client.entity';
import { ClientContactEntity } from '../client/client-contact.entity';
import { ClientContractEntity } from '../client/client-contract.entity';
import { ClientService } from '../client/client.service';

/**
 * Deleting a child row must not make its parent uneditable.
 *
 * Both `BranchEntity` and `ClientEntity` declare `cascade: true` collections, and both detail
 * reads join those collections filtered to `isActive = true` so a soft-deleted row does not
 * show in the UI. Handing such a filtered collection to `save()` tells TypeORM that the rows
 * the filter excluded have left the collection, so it orphans them — `UPDATE branch_contacts
 * SET branch_id = NULL`. That column is `NOT NULL`, Postgres refuses, the transaction rolls
 * back, and the whole request answers 500.
 *
 * The effect in the product: delete one branch contact, and every subsequent edit of that
 * branch is a 500, permanently. Reproduced live on `PUT /branches/:id` after `DELETE
 * /branches/:id/contacts/:contactId`, again through the document route, and again on
 * `PUT /clients/:id` after `DELETE /clients/:id/contacts/:contactId`.
 *
 * The fix is that the write paths load the parent row alone (`loadForWrite`) instead of the
 * filtered aggregate, because not one of them reads the child collections. These tests run the
 * real services against real Postgres, because the defect lives in the interaction between a
 * query's join filter, a relation's cascade setting and a NOT NULL constraint — and no two of
 * those three are visible to a unit test with a mocked repository.
 */
describe('editing a parent after one of its children was deleted', () => {
  jest.setTimeout(60000);

  let ds: DataSource;
  let branchService: BranchService;
  let clientService: ClientService;
  let branches: Repository<BranchEntity>;
  let branchContacts: Repository<BranchContactEntity>;
  let branchDocs: Repository<BranchDocumentEntity>;
  let clients: Repository<ClientEntity>;
  let clientContacts: Repository<ClientContactEntity>;
  let clientContracts: Repository<ClientContractEntity>;

  const RUN = `AWO${Date.now().toString().slice(-9)}`;
  const USER = 'aggregate-write-orphans-spec';
  const createdBranches: string[] = [];
  const createdClients: string[] = [];

  /** Nothing here exercises audit, events, cache or geo — they only have to not explode. */
  const noop = () => undefined;
  const stubAudit = { recordEvent: async () => undefined } as any;
  const stubEvents = { publish: noop } as any;

  beforeAll(async () => {
    if (!AppDataSource.isInitialized) await AppDataSource.initialize();
    ds = AppDataSource;
    branches = ds.getRepository(BranchEntity);
    branchContacts = ds.getRepository(BranchContactEntity);
    branchDocs = ds.getRepository(BranchDocumentEntity);
    clients = ds.getRepository(ClientEntity);
    clientContacts = ds.getRepository(ClientContactEntity);
    clientContracts = ds.getRepository(ClientContractEntity);

    const queryService = new BranchQueryService(branches);
    branchService = new BranchService(
      branches,
      branchContacts,
      branchDocs,
      ds.getRepository('ZoneEntity') as any,
      ds.getRepository('GeoStateEntity') as any,
      ds.getRepository('GeoDistrictEntity') as any,
      ds.getRepository('GeoCityEntity') as any,
      { findOne: async () => null } as any,
      stubAudit,
      queryService,
      stubEvents,
      { precisionFor: async () => null, resolve: async () => null } as any,
      ds,
    );

    clientService = new ClientService(
      clients,
      ds.getRepository('ClientConfigurationEntity') as any,
      clientContacts,
      clientContracts,
      ds.getRepository('ClientBillingEntity') as any,
      stubAudit,
      stubEvents,
      { del: async () => undefined, get: async () => null, set: async () => undefined } as any,
      { executeTransition: async () => undefined } as any,
      { assertRegionAllowedStaged: async () => undefined, stagedMode: async () => 'off' } as any,
      ds,
    );
  });

  afterAll(async () => {
    for (const id of createdBranches) {
      await branchContacts.delete({ branchId: id });
      await branchDocs.delete({ branchId: id });
      await branches.delete({ id });
    }
    for (const id of createdClients) {
      await clientContacts.delete({ clientId: id });
      await clientContracts.delete({ clientId: id });
      await clients.delete({ id });
    }
    if (ds?.isInitialized) await ds.destroy();
  });

  const newBranch = async (tag: string) => {
    const b = await branches.save(branches.create({
      solId: `${RUN}${tag}`, name: `${RUN} ${tag}`, address: 'Test address',
      state: 'West Bengal', district: 'Kolkata', city: 'Kolkata',
      createdBy: USER, updatedBy: USER,
    }));
    createdBranches.push(b.id);
    return b;
  };

  const newClient = async (tag: string) => {
    const c = await clients.save(clients.create({
      clientCode: `${RUN}${tag}`, name: `${RUN} ${tag}`, displayName: `${RUN} ${tag}`,
      createdBy: USER, updatedBy: USER,
    }));
    createdClients.push(c.id);
    return c;
  };

  it('a branch whose contact was deleted is still editable, and the contact keeps its branch', async () => {
    const branch = await newBranch('B1');
    const contact = await branchService.addContact(branch.id, {
      name: 'Deleted Later', email: 'gone@example.com', phone: '9990000001', designation: 'Manager',
    } as any, USER);

    // The edit works while the contact is live — so a failure after the delete is the delete's doing.
    await expect(branchService.update(branch.id, { managerName: 'Before' } as any, USER)).resolves.toBeTruthy();

    await branchService.removeContact(contact.id, USER);
    const afterDelete = await branchContacts.findOne({ where: { id: contact.id } });
    expect(afterDelete?.isActive).toBe(false);

    // This is the call that answered 500.
    const updated = await branchService.update(branch.id, { managerName: 'After' } as any, USER);
    expect(updated.managerName).toBe('After');

    const row = await branchContacts.findOne({ where: { id: contact.id } });
    expect(row).not.toBeNull();
    expect(row!.branchId).toBe(branch.id);
  });

  it('the same holds for a deleted branch document', async () => {
    const branch = await newBranch('B2');
    const doc = await branchService.addDocument(branch.id, {
      fileName: 'gone.pdf', filePath: '/tmp/gone.pdf', fileSize: 10, category: 'OTHER',
    } as any, USER);

    await branchService.removeDocument(doc.id, USER);

    const updated = await branchService.update(branch.id, { managerName: 'After doc' } as any, USER);
    expect(updated.managerName).toBe('After doc');

    const row = await branchDocs.findOne({ where: { id: doc.id } });
    expect(row!.branchId).toBe(branch.id);
  });

  /** `remove` loaded the same filtered aggregate, so archiving hit the identical wall. */
  it('a branch whose contact was deleted can still be archived', async () => {
    const branch = await newBranch('B3');
    const contact = await branchService.addContact(branch.id, {
      name: 'Blocks Archive', email: 'arch@example.com', phone: '9990000003', designation: 'Manager',
    } as any, USER);
    await branchService.removeContact(contact.id, USER);

    await expect(branchService.remove(branch.id, USER)).resolves.toBeUndefined();
    expect((await branches.findOne({ where: { id: branch.id } }))!.isActive).toBe(false);
    expect((await branchContacts.findOne({ where: { id: contact.id } }))!.branchId).toBe(branch.id);
  });

  it('a client whose contact was deleted is still editable, and the contact keeps its client', async () => {
    const client = await newClient('C1');
    const contact = await clientService.addContact(client.id, {
      name: 'Deleted Later', email: 'gone@example.com', phone: '9990000004', designation: 'Manager',
    } as any, USER);

    await expect(clientService.update(client.id, { website: 'https://before.example.com' } as any, USER)).resolves.toBeTruthy();

    await clientService.removeContact(contact.id, USER);

    const updated = await clientService.update(client.id, { website: 'https://after.example.com' } as any, USER);
    expect(updated.website).toBe('https://after.example.com');

    const row = await clientContacts.findOne({ where: { id: contact.id } });
    expect(row).not.toBeNull();
    expect(row!.clientId).toBe(client.id);
  });

  /**
   * The reason the rule exists, pinned so it cannot quietly stop being true.
   *
   * If TypeORM ever stopped orphaning excluded rows, the `loadForWrite` indirection would look
   * like dead weight and somebody would remove it. This test fails in that case, which is the
   * signal to revisit the rule deliberately rather than discover it through a 500.
   */
  it('still refuses the filtered aggregate, which is why the write paths must not load it', async () => {
    const branch = await newBranch('B4');
    const contact = await branchService.addContact(branch.id, {
      name: 'Orphan Me', email: 'orphan@example.com', phone: '9990000005', designation: 'Manager',
    } as any, USER);
    await branchService.removeContact(contact.id, USER);

    const aggregate = await new BranchQueryService(branches).findOne(branch.id);
    expect(aggregate.contacts).toHaveLength(0); // the deleted contact was filtered out
    aggregate.managerName = 'Via the aggregate';

    await expect(branches.save(aggregate)).rejects.toThrow();
    expect((await branchContacts.findOne({ where: { id: contact.id } }))!.branchId).toBe(branch.id);
  });
});
