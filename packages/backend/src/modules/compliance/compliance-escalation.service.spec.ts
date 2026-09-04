import { ComplianceEscalationService } from './compliance-escalation.service';

describe('ComplianceEscalationService', () => {
  let incidents: any;
  let rightsRequests: any;
  let notificationDispatch: any;
  let service: ComplianceEscalationService;

  const incidentView = (overrides: any) => ({
    id: 'inc-1',
    title: 'Old breach',
    clocks: {
      certIn: { applicable: true, overdue: false, satisfied: false },
      dpdpBoard: { applicable: true, overdue: false, satisfied: false },
      dpdpPrincipals: { applicable: true, overdue: false, satisfied: false },
    },
    ...overrides,
  });

  const requestView = (overrides: any) => ({
    id: 'req-1',
    requestType: 'ACCESS',
    sla: { overdue: false, daysRemaining: 10, satisfied: false },
    ...overrides,
  });

  beforeEach(() => {
    incidents = { list: jest.fn().mockResolvedValue([]) };
    rightsRequests = { list: jest.fn().mockResolvedValue([]) };
    notificationDispatch = { emitSafe: jest.fn() };
    service = new ComplianceEscalationService(incidents, rightsRequests, notificationDispatch);
  });

  it('raises nothing when every clock and SLA is healthy', async () => {
    incidents.list.mockResolvedValue([incidentView({})]);
    rightsRequests.list.mockResolvedValue([requestView({})]);
    await service.scan();
    expect(notificationDispatch.emitSafe).not.toHaveBeenCalled();
  });

  it('raises a CERT-In breach for an incident whose 6-hour clock is overdue', async () => {
    incidents.list.mockResolvedValue([
      incidentView({ clocks: { ...incidentView({}).clocks, certIn: { applicable: true, overdue: true, satisfied: false } } }),
    ]);
    await service.scan();
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SECURITY_INCIDENT_CLOCK_BREACHED',
        entityId: 'inc-1',
        dedupeKey: expect.stringMatching(/^SECURITY_INCIDENT_CLOCK_BREACHED:inc-1:certIn:/),
        payload: expect.objectContaining({ title: 'Old breach', clockName: 'CERT-In 6-hour' }),
      }),
    );
  });

  it('raises a DPDP Board breach independently of the CERT-In clock, with its own dedupe key', async () => {
    incidents.list.mockResolvedValue([
      incidentView({ clocks: { ...incidentView({}).clocks, dpdpBoard: { applicable: true, overdue: true, satisfied: false } } }),
    ]);
    await service.scan();
    expect(notificationDispatch.emitSafe).toHaveBeenCalledTimes(1);
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SECURITY_INCIDENT_CLOCK_BREACHED',
        dedupeKey: expect.stringMatching(/^SECURITY_INCIDENT_CLOCK_BREACHED:inc-1:dpdpBoard:/),
        payload: expect.objectContaining({ clockName: 'DPDP Board 72-hour report' }),
      }),
    );
  });

  it('raises both clocks separately when an incident has breached CERT-In and the Board deadline', async () => {
    incidents.list.mockResolvedValue([
      incidentView({
        clocks: {
          certIn: { applicable: true, overdue: true, satisfied: false },
          dpdpBoard: { applicable: true, overdue: true, satisfied: false },
          dpdpPrincipals: { applicable: true, overdue: false, satisfied: false },
        },
      }),
    ]);
    await service.scan();
    expect(notificationDispatch.emitSafe).toHaveBeenCalledTimes(2);
  });

  it('raises a rights-request SLA breach with the overdue day count', async () => {
    rightsRequests.list.mockResolvedValue([requestView({ sla: { overdue: true, daysRemaining: -5.4, satisfied: false } })]);
    await service.scan();
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'DATA_RIGHTS_REQUEST_SLA_BREACH',
        entityId: 'req-1',
        dedupeKey: expect.stringMatching(/^DATA_RIGHTS_REQUEST_SLA_BREACH:req-1:/),
        payload: expect.objectContaining({ requestType: 'ACCESS', days: 5 }),
      }),
    );
  });
});
