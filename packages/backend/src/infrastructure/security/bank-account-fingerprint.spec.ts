import { readFileSync } from 'fs';
import { join } from 'path';
import { bankAccountFingerprint, fieldFingerprint, __resetKeyCacheForTests } from './field-encryption';
import { AssayerEntity } from '../../modules/assayer/assayer.entity';

/**
 * Audit F3 (2026-09-24, owner's decision): a payout approval is refused when its bank account is
 * also on another assayer's record. The account column is encrypted with a random IV, so the only
 * way to ask that with an index is a keyed fingerprint of the NORMALISED number — kept by the
 * entity on every write and backfilled by `BankAccountFingerprint1801300000000`.
 */
describe('bankAccountFingerprint', () => {
  const KEY = 'b'.repeat(64);
  beforeEach(() => { process.env.PII_ENCRYPTION_KEY = KEY; __resetKeyCacheForTests(); });
  afterEach(() => { delete process.env.PII_ENCRYPTION_KEY; __resetKeyCacheForTests(); });

  it('is one fingerprint for one account however it was typed', () => {
    const fp = bankAccountFingerprint('123456789012');
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(bankAccountFingerprint('1234 5678 9012')).toBe(fp);
    expect(bankAccountFingerprint('1234-5678.9012')).toBe(fp);
    expect(bankAccountFingerprint(' 123456789012 ')).toBe(fp);
  });

  it('differs for a different account', () => {
    expect(bankAccountFingerprint('123456789012')).not.toBe(bankAccountFingerprint('123456789013'));
  });

  it('is nothing for a blank, and nothing with no key configured', () => {
    expect(bankAccountFingerprint('')).toBeNull();
    expect(bankAccountFingerprint(' - ')).toBeNull();
    expect(bankAccountFingerprint(null)).toBeNull();
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
    expect(bankAccountFingerprint('123456789012')).toBeNull();
  });

  it('the entity keeps it in step with the account on every write', () => {
    const a = new AssayerEntity();
    a.bankAccountNumber = '1234 5678 9012';
    a.deriveIdentifierFingerprints();
    expect(a.bankAccountFingerprint).toBe(fieldFingerprint('123456789012'));
    a.bankAccountNumber = null;
    a.deriveIdentifierFingerprints();
    expect(a.bankAccountFingerprint).toBeNull();
  });
});

describe('BankAccountFingerprint1801300000000', () => {
  const migration = readFileSync(
    join(__dirname, '../database/migrations/1801300000000-BankAccountFingerprint.ts'), 'utf8',
  );
  const entity = readFileSync(join(__dirname, '../../modules/assayer/assayer.entity.ts'), 'utf8');

  it('adds the column and a partial index under the name the entity declares', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "bank_account_fingerprint" character varying(64)');
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS "idx_assayers_bank_account_fingerprint"[\s\S]*WHERE "bank_account_fingerprint" IS NOT NULL/);
    expect(entity).toContain(`@Index('idx_assayers_bank_account_fingerprint', { where: '"bank_account_fingerprint" IS NOT NULL' })`);
  });

  it('backfills existing accounts through the same function the entity uses', () => {
    expect(migration).toContain('bankAccountFingerprint(decryptField(');
  });
});
