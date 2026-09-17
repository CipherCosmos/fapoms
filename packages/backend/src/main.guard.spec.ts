import { randomBytes } from 'crypto';
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
    // A real generated secret, not a repeated character — 'a'.repeat(48) passed the length check
    // this fixture exists to satisfy, but is exactly the low-variety shape the entropy check below
    // now also refuses, on purpose. See the "does not look randomly generated" tests.
    JWT_SECRET: randomBytes(32).toString('hex'),
    DB_SYNCHRONIZE: 'false',
    CORS_ORIGINS: 'https://fapoms.example.com',
    DB_PASSWORD: 'a-genuinely-random-production-password',
    STORAGE_DRIVER: 's3',
    PII_ENCRYPTION_KEY: 'b'.repeat(64),
    FILE_SCAN_REQUIRED: 'true',
  };

  beforeEach(() => {
    // Not `{ ...original }` alone: the real process running this suite may itself have
    // S3_ENDPOINT / MINIO_ROOT_PASSWORD set (e.g. a loaded .env.docker), and a test that never
    // mentions either key would then silently inherit whichever value happens to be on this
    // machine — passing or failing depending on who runs it, not on what the test asserts. Every
    // env key a check in this file reads must be named here so a test's outcome depends only on
    // what that test itself sets.
    const env = { ...original };
    delete env.S3_ENDPOINT;
    delete env.MINIO_ROOT_PASSWORD;
    delete env.AWS_SECRET_ACCESS_KEY;
    process.env = env;
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

  it('refuses a JWT secret that is long enough but is a repeated character, not real entropy', () => {
    process.env = { ...process.env, ...safeProduction, JWT_SECRET: 'x'.repeat(40) };
    expect(() => assertProductionSafeConfig()).toThrow(/does not look randomly generated/);
  });

  it('refuses a JWT secret that is long enough but reads like an unrotated placeholder', () => {
    process.env = {
      ...process.env,
      ...safeProduction,
      JWT_SECRET: 'thisIsTheSuperSecretProductionKeyChangeme1234567890',
    };
    expect(() => assertProductionSafeConfig()).toThrow(/does not look randomly generated/);
  });

  it('refuses a DB_PASSWORD long enough to dodge the known-default list but still low-variety', () => {
    process.env = { ...process.env, ...safeProduction, DB_PASSWORD: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzz' };
    expect(() => assertProductionSafeConfig()).toThrow(/DB_PASSWORD does not look randomly generated/);
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

  it('refuses to start in production with malware scanning off — KYC/audit uploads must be scanned', () => {
    const env: any = { ...process.env, ...safeProduction };
    delete env.FILE_SCAN_REQUIRED; // not "true"
    process.env = env;
    expect(() => assertProductionSafeConfig()).toThrow(/FILE_SCAN_REQUIRED/);
    process.env = { ...process.env, ...safeProduction, FILE_SCAN_REQUIRED: 'false' };
    expect(() => assertProductionSafeConfig()).toThrow(/FILE_SCAN_REQUIRED/);
  });

  it('refuses to start without a PII encryption key — PAN and bank numbers would be plaintext', () => {
    const env: any = { ...process.env, ...safeProduction };
    delete env.PII_ENCRYPTION_KEY;
    process.env = env;
    expect(() => assertProductionSafeConfig()).toThrow(/PII_ENCRYPTION_KEY/);
  });

  it('accepts a 32-byte base64 PII key as well as 64 hex chars', () => {
    process.env = { ...process.env, ...safeProduction, PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect(() => assertProductionSafeConfig()).not.toThrow();
  });

  /**
   * SELF-HOSTED MINIO. The API needs a credential limited to the documents bucket, not the store's
   * root. These pin that: root is no longer required in the API's environment, and the API signing
   * with root — or with the burned literal committed to this public repository's history — is
   * refused.
   */
  const minio = { S3_ENDPOINT: 'http://minio:9000' };
  const appCredential = 'a-genuinely-random-app-user-secret';

  it('refuses a self-hosted MinIO deployment with no storage credential', () => {
    process.env = { ...process.env, ...safeProduction, ...minio };
    expect(() => assertProductionSafeConfig()).toThrow(/AWS_SECRET_ACCESS_KEY/);
  });

  it('refuses the burned dev default as the credential the API signs with', () => {
    process.env = { ...process.env, ...safeProduction, ...minio, AWS_SECRET_ACCESS_KEY: 'fapoms_minio_secret' };
    expect(() => assertProductionSafeConfig()).toThrow(/burned dev default/);
  });

  it('refuses the burned dev default as the root password, if root is present at all', () => {
    process.env = {
      ...process.env, ...safeProduction, ...minio,
      AWS_SECRET_ACCESS_KEY: appCredential, MINIO_ROOT_PASSWORD: 'fapoms_minio_secret',
    };
    expect(() => assertProductionSafeConfig()).toThrow(/MINIO_ROOT_PASSWORD is the burned dev default/);
  });

  it('refuses an API that signs its storage requests with the root credential', () => {
    const root = 'a-genuinely-random-minio-root-password';
    process.env = {
      ...process.env, ...safeProduction, ...minio,
      AWS_SECRET_ACCESS_KEY: root, MINIO_ROOT_PASSWORD: root,
    };
    expect(() => assertProductionSafeConfig()).toThrow(/signs storage requests with the MinIO ROOT credential/);
  });

  /** The intended state: a bucket-limited user, and no root credential in the API at all. */
  it('accepts a bucket-limited credential with root absent from the API', () => {
    process.env = { ...process.env, ...safeProduction, ...minio, AWS_SECRET_ACCESS_KEY: appCredential };
    expect(() => assertProductionSafeConfig()).not.toThrow();
  });

  it('does not require MINIO_ROOT_PASSWORD when pointed at real AWS S3', () => {
    const env: any = {
      ...process.env,
      ...safeProduction,
      S3_ENDPOINT: 'https://s3.ap-south-1.amazonaws.com',
    };
    delete env.MINIO_ROOT_PASSWORD;
    process.env = env;
    expect(() => assertProductionSafeConfig()).not.toThrow();
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
