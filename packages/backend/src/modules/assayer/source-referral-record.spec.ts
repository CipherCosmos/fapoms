import { AssayerService } from './assayer.service';

/** Who referred a person, kept on their record — in the shared shape, and on the audit trail. */
describe('AssayerService.setSourceReferral', () => {
  const setup = (existing: unknown = null) => {
    const svc: any = Object.create(AssayerService.prototype);
    svc.findOne = jest.fn(async () => ({ id: 'a-1', sourceReferral: existing }));
    svc.assayerRepository = { update: jest.fn(async () => undefined) };
    svc.auditService = { recordEventSafe: jest.fn(async () => undefined) };
    return svc;
  };
  const ravi = { type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.in' };

  it('stores it tidy, stamped HR by default, and says what it replaced', async () => {
    const svc = setup({ ...ravi, name: 'Old Name', recordedBy: 'CANDIDATE' });
    const saved = await svc.setSourceReferral('a-1', ravi, 'hr-1');

    expect(saved).toEqual({ ...ravi, recordedBy: 'HR' });
    expect(svc.assayerRepository.update).toHaveBeenCalledWith({ id: 'a-1' }, { sourceReferral: saved, updatedBy: 'hr-1' });
    const event = svc.auditService.recordEventSafe.mock.calls[0][0];
    expect(event.eventType).toBe('ASSAYER_SOURCE_REFERRAL_SET');
    expect(event.remarks).toMatch(/Referred by Ravi Kumar .* \(was Old Name/);
  });

  it('keeps the candidate as the recorder when promotion carries their entry', async () => {
    const svc = setup();
    await expect(svc.setSourceReferral('a-1', ravi, 'hr-1', 'CANDIDATE')).resolves.toMatchObject({ recordedBy: 'CANDIDATE' });
  });

  it('clears it on null', async () => {
    const svc = setup({ ...ravi, recordedBy: 'HR' });
    await expect(svc.setSourceReferral('a-1', null, 'hr-1')).resolves.toBeNull();
    expect(svc.auditService.recordEventSafe.mock.calls[0][0].remarks).toMatch(/cleared/);
  });

  it('refuses what the shared rule refuses, writing nothing', async () => {
    const svc = setup();
    await expect(svc.setSourceReferral('a-1', { ...ravi, type: 'FRIEND' }, 'hr-1')).rejects.toThrow(/an assayer, our staff/);
    expect(svc.assayerRepository.update).not.toHaveBeenCalled();
  });
});
