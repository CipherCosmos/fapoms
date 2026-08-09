import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { MetricsAuthGuard } from './metrics-auth.guard';

describe('MetricsAuthGuard', () => {
  function ctx(authorization?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ headers: authorization ? { authorization } : {} }),
      }),
    } as unknown as ExecutionContext;
  }

  const guardWith = (token?: string) =>
    new MetricsAuthGuard({ get: () => token } as any);

  it('is a no-op (allows) when METRICS_TOKEN is unset', () => {
    expect(guardWith(undefined).canActivate(ctx())).toBe(true);
    expect(guardWith(undefined).canActivate(ctx('Bearer anything'))).toBe(true);
  });

  it('allows a request carrying the correct bearer token', () => {
    expect(guardWith('s3cr3t').canActivate(ctx('Bearer s3cr3t'))).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(() => guardWith('s3cr3t').canActivate(ctx('Bearer nope'))).toThrow(UnauthorizedException);
  });

  it('rejects a missing token when one is configured', () => {
    expect(() => guardWith('s3cr3t').canActivate(ctx())).toThrow(UnauthorizedException);
  });
});
