import { MigrationInterface, QueryRunner } from 'typeorm';
import { encryptField, isEncrypted } from '../../security/field-encryption';
import { REGISTRATION_SECRET_FIELD_KEYS } from '@fapoms/shared';

/**
 * ENCRYPT THE IDENTITY NUMBERS ALREADY SITTING IN APPLICATIONS.
 *
 * `assayers` has encrypted PAN, Aadhaar and bank account for a long time. `assayer_applications`
 * kept the same numbers as plain text inside `extended_profile->fields`, and an audit found them in
 * the clear in the live database. New answers are sealed as they are typed; the rows written before
 * that are sealed here.
 *
 * Runs in the deploy step, which is the only process holding `PII_ENCRYPTION_KEY` outside the API.
 * Without a key it stops rather than pretending: `encryptField` passes plaintext through, and a
 * migration that silently left every number readable would be worse than one that refuses.
 *
 * Deliberately has no `down`. Re-encrypting is not the risk; a rollback that wrote these numbers
 * back out in the clear is.
 */
export class SealApplicationIdentityNumbers1798800000000 implements MigrationInterface {
  name = 'SealApplicationIdentityNumbers1798800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{ id: string; extended_profile: Record<string, unknown> | null }> =
      await queryRunner.query(`
        SELECT id, extended_profile
        FROM assayer_applications
        WHERE extended_profile -> 'fields' IS NOT NULL
      `);
    if (rows.length === 0) return;

    if (!isEncrypted(encryptField('probe'))) {
      throw new Error(
        'PII_ENCRYPTION_KEY is not configured, so candidate identity numbers cannot be encrypted. '
        + 'Set the key on the deploy step and run this migration again.',
      );
    }

    let sealed = 0;
    for (const row of rows) {
      const profile = (row.extended_profile ?? {}) as Record<string, unknown>;
      const fields = (profile.fields ?? {}) as Record<string, unknown>;
      let changed = false;
      for (const key of REGISTRATION_SECRET_FIELD_KEYS) {
        const value = fields[key];
        if (typeof value !== 'string' || value.trim() === '' || isEncrypted(value)) continue;
        fields[key] = encryptField(value.trim());
        changed = true;
      }
      if (!changed) continue;
      await queryRunner.query(
        `UPDATE assayer_applications SET extended_profile = $1 WHERE id = $2`,
        [JSON.stringify({ ...profile, fields }), row.id],
      );
      sealed++;
    }
    // Counts only: an application id identifies a person.
    console.log(`SealApplicationIdentityNumbers: sealed identity numbers on ${sealed} of ${rows.length} applications.`);
  }

  public async down(): Promise<void> {
    // Intentionally empty — see the note above.
  }
}
