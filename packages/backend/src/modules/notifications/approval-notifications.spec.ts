import { NOTIFICATION_CATALOG } from './notification-catalog';

/**
 * Who hears that somebody is waiting for approval before training (2026-09-23): the approvers —
 * Admins, and any custom role holding BOTH the approve permission and the roster's view (the link is
 * the record; an approver who could not open it could not act). Never HR's own OPERATIONS desk,
 * and never whoever sent it up.
 */
describe('notifications for the approvers', () => {
  it.each(['ASSAYER_SENT_FOR_APPROVAL', 'ASSAYER_APPROVAL_ANSWERED'])('%s reaches the approvers, and only them', (type) => {
    const def = (NOTIFICATION_CATALOG as Record<string, any>)[type];
    expect(def.roles).toEqual(['ADMIN']);
    expect(def.fallbackPermissions).toEqual(['ASSAYER:APPROVE:ORGANIZATION', 'ASSAYER:VIEW:ORGANIZATION']);
    expect(def.skipActor).toBe(true);
    expect(def.channels).toEqual(expect.arrayContaining(['IN_APP', 'EMAIL']));
    // The approver's review: their whole file and the decision on one screen (2026-09-24).
    expect(def.link).toBe('/hr/approvals/${assayerId}');
  });
});

/** And back to HR: only the people who prepared the round, each addressed by name. */
describe('notifications for HR', () => {
  it.each(['ASSAYER_APPROVAL_INFO_REQUESTED', 'ASSAYER_APPROVAL_APPROVED', 'ASSAYER_APPROVAL_REJECTED'])('%s goes to the preparers only', (type) => {
    const def = (NOTIFICATION_CATALOG as Record<string, any>)[type];
    expect(def.roles).toEqual([]);
    expect(def.special).toEqual(['RECORD_OWNER']);
    expect(def.skipActor).toBe(true);
    expect(def.link).toBe('/hr/roster/${assayerId}');
  });

  it('emails the two that need HR to do something, and keeps a plain approval to the bell', () => {
    const cat = NOTIFICATION_CATALOG as Record<string, any>;
    expect(cat.ASSAYER_APPROVAL_INFO_REQUESTED.channels).toContain('EMAIL');
    expect(cat.ASSAYER_APPROVAL_REJECTED.channels).toContain('EMAIL');
    expect(cat.ASSAYER_APPROVAL_APPROVED.channels).toEqual(['IN_APP']);
  });
});
