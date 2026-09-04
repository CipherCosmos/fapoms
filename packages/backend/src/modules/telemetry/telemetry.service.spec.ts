import { TelemetryService } from './telemetry.service';

describe('TelemetryService.record', () => {
  let repo: any;
  let service: TelemetryService;

  beforeEach(() => {
    repo = {
      create: jest.fn((d: any) => d),
      save: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };
    service = new TelemetryService(repo);
  });

  it('attributes identity from the request context, never the payload', async () => {
    await service.record(
      // The client tries to claim a different user/session — it must be ignored.
      [{ eventType: 'PAGE_VIEW', path: '/dashboard', userId: 'attacker', sessionId: 'x' } as any],
      { userId: 'real-user', sessionId: 'real-session', ipAddress: '203.0.113.5' },
    );
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'real-user', sessionId: 'real-session', ipAddress: '203.0.113.5' }),
    );
  });

  it('drops events that fail the allowlist and counts only what it stored', async () => {
    const n = await service.record(
      [
        { eventType: 'ACTION', label: 'Save' },
        { eventType: 'NOPE' as any, label: 'x' },
        { eventType: 'FILTER', label: 'status' },
      ],
      { userId: 'u1' },
    );
    expect(n).toBe(2);
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('records nothing (and does not hit the DB) for an empty or all-invalid batch', async () => {
    expect(await service.record([], { userId: 'u1' })).toBe(0);
    expect(await service.record([{ eventType: 'BAD' } as any], { userId: 'u1' })).toBe(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('caps the batch at the maximum', async () => {
    const many = Array.from({ length: 200 }, () => ({ eventType: 'ACTION', label: 'x' }));
    const n = await service.record(many, { userId: 'u1' });
    expect(n).toBe(50); // MAX_TELEMETRY_BATCH
  });
});
