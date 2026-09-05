import { resolveRecordSection, RECORD_TAB_KEYS, RECORD_LINK_PARAMS, SUMMARY_GROUP_KEYS } from './record-sections';

/**
 * The `?section=` vocabulary on links into an assayer record.
 *
 * This parameter has already been dead once: HR Pay wrote `section=financial` for an edit
 * modal that had been removed, nothing read it, and the link quietly landed a clerk on the
 * top of the record instead of on the bank fields it named. These tests pin the names other
 * screens are allowed to rely on, so retiring a consumer again shows up here rather than as
 * a link that still works but no longer goes anywhere in particular.
 */
describe('what ?section= on a record link may name', () => {
  it('lands financial on the Summary, at the "How they are paid" group — the HR Pay bank link', () => {
    expect(resolveRecordSection('financial')).toEqual({ tab: 'summary', group: 'financial' });
  });

  it('lands identity on the Summary, at "Who they are" — the HR Pay PAN link', () => {
    expect(resolveRecordSection('identity')).toEqual({ tab: 'summary', group: 'identity' });
  });

  it('opens any tab by its own key', () => {
    for (const tab of RECORD_TAB_KEYS) {
      expect(resolveRecordSection(tab)).toEqual({ tab });
    }
  });

  it('lands every Summary group on the Summary, anchored to itself', () => {
    for (const group of SUMMARY_GROUP_KEYS) {
      expect(resolveRecordSection(group)).toEqual({ tab: 'summary', group });
    }
  });

  it('accepts the word on the screen where it differs from the key — the tab is labelled Pay & terms', () => {
    expect(resolveRecordSection('pay')).toEqual({ tab: 'commercial' });
  });

  it('shrugs off case and stray space, which hand-written links will have', () => {
    expect(resolveRecordSection(' Financial ')).toEqual({ tab: 'summary', group: 'financial' });
  });

  it('turns anything unrecognised into "no jump", never a crash or a blank pane', () => {
    expect(resolveRecordSection('bank-details')).toBeNull();
    expect(resolveRecordSection('')).toBeNull();
    expect(resolveRecordSection('   ')).toBeNull();
    expect(resolveRecordSection(null)).toBeNull();
    expect(resolveRecordSection(undefined)).toBeNull();
  });

  it('forwards exactly the parameters the record consumes, and consumes what it forwards', () => {
    // The roster redirect forwards these; AssayerRecord's arrival effect reads and strips
    // exactly these two. A name added to one side without the other either never arrives
    // or arrives and sticks to the URL forever.
    expect([...RECORD_LINK_PARAMS].sort()).toEqual(['edit', 'section']);
  });
});
