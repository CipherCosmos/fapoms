import { changedFormKeys, buildAssayerEditBody } from './assayer-shared';

/**
 * What an edit sends, and what it must leave alone.
 *
 * The edit form pre-fills every field with the record's current value — correct for a screen
 * whose job is to show what is there. Handing all of it to the server meant every save rewrote
 * every column, so two clerks working on different sections of the same person overwrote each
 * other without either touching the other's fields. Nothing in the request said so; both saves
 * returned 200.
 */
describe('what an edit actually sends', () => {
  const initial = {
    firstName: 'Asha', lastName: 'Rao', phone: '+919000000001',
    address: '12 Nehru Road', bankAccountNumber: '1234567890',
    workingHoursStart: '09:00', workingHoursEnd: '17:00',
  };

  it('sends only the box that moved', () => {
    const form = { ...initial, phone: '+919000000002' };
    expect(changedFormKeys(form, initial)).toEqual(['phone']);
  });

  it('sends nothing when nothing moved', () => {
    expect(changedFormKeys({ ...initial }, initial)).toEqual([]);
  });

  it('leaves every untouched field out, so a concurrent edit elsewhere survives', () => {
    // The defect: this used to include address and bankAccountNumber, stamping them back with
    // the values from when the modal opened.
    const form = { ...initial, firstName: 'Asha Kiran' };
    const changed = changedFormKeys(form, initial);
    expect(changed).not.toContain('address');
    expect(changed).not.toContain('bankAccountNumber');
  });

  it('counts a cleared box as a change, because emptying a field is an edit', () => {
    const form = { ...initial, address: '' };
    expect(changedFormKeys(form, initial)).toEqual(['address']);
  });

  describe('working hours', () => {
    it('carries both halves when either one moves', () => {
      // The server stores the pair as one object, so a changed start without the unchanged end
      // reads as "clear the end time".
      const form = { ...initial, workingHoursStart: '10:00' };
      expect(changedFormKeys(form, initial).sort()).toEqual(['workingHoursEnd', 'workingHoursStart']);
    });

    it('carries neither when neither moved', () => {
      expect(changedFormKeys({ ...initial }, initial)).toEqual([]);
    });
  });

  describe('and what the body then looks like', () => {
    const FIELDS = [
      { key: 'phone', label: 'Phone' },
      { key: 'address', label: 'Address' },
      { key: 'workingHoursStart', label: 'From' },
      { key: 'workingHoursEnd', label: 'To' },
    ];

    it('names only the changed field', () => {
      const form = { ...initial, phone: '+919000000002' };
      const touched: Record<string, string | undefined> = {};
      for (const k of changedFormKeys(form, initial)) touched[k] = form[k];

      const { body } = buildAssayerEditBody(FIELDS as any, touched, {} as any);
      expect(Object.keys(body)).toEqual(['phone']);
    });
  });
});
