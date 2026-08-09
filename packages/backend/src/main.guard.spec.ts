import { assertProductionSafeConfig } from './main';

/**
 * These cover the boot guard that stands between a development configuration and a
 * production database holding bank audit evidence. Each condition it checks is silent at the
 * moment it matters, so the guard failing open would be invisible until damage was done.
 */
describe('assertProductionSafeConfig', () => {
  const original = process.env;

  const safeProduction = {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(48),
    DB_SYNCHRONIZE: 'false',
    CORS_ORIGINS: 'https://fapoms.example.com',
    DB_PASSWORD: 'a-genuinely-random-production-password',
    STORAGE_DRIVER: 's3',
  };

  beforeEach(() => {
    process.env = { ...original };
  });

  afterAll(() => {
    process.env = original;
  });

  it('permits a correctly configured production environment', () => {
    process.env = { ...process.env, ...safeProduction };
    expect(() => assertProductionSafeConfig()).not.toThrow();
  });

  it('does nothing outside production, so development keeps working', () => {
    process.env = { ...process.env, NODE_ENV: 'development', DB_SYNCHRONIZE: 'true', JWT_SECRET: 'dev-secret' };
    expect(() => assertProductionSafeConfig()).not.toThrow();
  });

  it('refuses to start with DB_SYNCHRONIZE=true — it rewrites the live schema', () => {
    process.env = { ...process.env, ...safeProduction, DB_SYNCHRONIZE: 'true' };
    expect(() => assertProductionSafeConfig()).toThrow(/DB_SYNCHRONIZE/);
  });

  it('refuses the development JWT secret', () => {
    process.env = { ...process.env, ...safeProduction, JWT_SECRET: 'dev-secret' };
    expect(() => assertProductionSafeConfig()).toThrow(/JWT_SECRET/);
  });

  it('refuses a short JWT secret', () => {
    process.env = { ...process.env, ...safeProduction, JWT_SECRET: 'tooshort' };
    expect(() => assertProductionSafeConfig()).toThrow(/32 characters/);
  });

  it('refuses a well-known database password', () => {
    process.env = { ...process.env, ...safeProduction, DB_PASSWORD: 'postgres' };
    expect(() => assertProductionSafeConfig()).toThrow(/DB_PASSWORD/);
  });

  it('refuses to fall back to localhost CORS origins', () => {
    const env: any = { ...process.env, ...safeProduction };
    delete env.CORS_ORIGINS;
    process.env = env;
    expect(() => assertProductionSafeConfig()).toThrow(/CORS_ORIGINS/);
  });

  it('refuses local-disk storage in production — audit evidence must go to s3', () => {
    const env: any = { ...process.env, ...safeProduction };
    delete env.STORAGE_DRIVER;
    process.env = env;
    expect(() => assertProductionSafeConfig()).toThrow(/STORAGE_DRIVER/);
  });

  it('refuses a JWT secret that was committed to git history', () => {
    process.env = {
      ...process.env,
      ...safeProduction,
      JWT_SECRET: 'fapoms-docker-dev-secret-key-change-in-production',
    };
    expect(() => assertProductionSafeConfig()).toThrow(/JWT_SECRET/);
  });

  it('reports every problem at once rather than one per restart', () => {
    process.env = {
      ...process.env,
      NODE_ENV: 'production',
      JWT_SECRET: 'dev-secret',
      DB_SYNCHRONIZE: 'true',
      DB_PASSWORD: 'postgres',
    } as any;
    delete (process.env as any).CORS_ORIGINS;

    try {
      assertProductionSafeConfig();
      fail('expected the guard to throw');
    } catch (err: any) {
      for (const key of ['JWT_SECRET', 'DB_SYNCHRONIZE', 'CORS_ORIGINS', 'DB_PASSWORD']) {
        expect(err.message).toContain(key);
      }
    }
  });
});
