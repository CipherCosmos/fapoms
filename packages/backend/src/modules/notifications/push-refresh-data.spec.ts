import { pushRefreshData } from './push-refresh-data';

describe('pushRefreshData — the ids a push carries so the app can refresh one item', () => {
  it('an assignment notification carries its assignment', () => {
    expect(pushRefreshData({ entityType: 'ASSIGNMENT', entityId: 'asn-1', payload: {} })).toEqual({ assignmentId: 'asn-1' });
  });
  it('a schedule notification carries the assignment from its payload', () => {
    expect(pushRefreshData({ entityType: 'SCHEDULE', entityId: 'sch-1', payload: { assignmentId: 'asn-2' } })).toEqual({ assignmentId: 'asn-2' });
  });
  it('an office question carries the query, and its assignment when the payload names one', () => {
    expect(pushRefreshData({ entityType: 'VALIDATION_QUERY', entityId: 'q-1', payload: { queryId: 'q-1', assignmentId: 'asn-3' } }))
      .toEqual({ queryId: 'q-1', assignmentId: 'asn-3' });
    // `assignmentId: ''` is what the query emit sends when it found no assignment — dropped, not sent.
    expect(pushRefreshData({ entityType: 'VALIDATION_QUERY', entityId: 'q-1', payload: { assignmentId: '' } })).toEqual({ queryId: 'q-1' });
  });
  it('adds nothing when there is nothing to name', () => {
    expect(pushRefreshData({ entityType: 'ASSAYER', entityId: 'a-1', payload: null })).toEqual({});
  });
});
