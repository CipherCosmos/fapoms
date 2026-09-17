import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as controllerModule from './assayer.controller';

/**
 * THE BODY THE BROWSER ACTUALLY SENDS.
 *
 * Verification was completely dead in the product and every test passed. The reviewing screen sends
 * `expectedContentHash` — the hash of the scan the reviewer just read — and the service has always
 * checked it: "verification cannot silently apply to a different content hash". The DTO in between
 * never declared the field, and the global pipe rejects unknown properties, so every attempt came
 * back `400: property expectedContentHash should not exist`.
 *
 * It stayed hidden because the service's own tests call the service directly. The wire — the shape
 * that crosses the network — had nothing testing it, so this file tests exactly that: the DTO
 * accepts what the client sends, under the same pipe settings the application runs.
 */
describe('the verify request the reviewing screen sends', () => {
  // The DTO is not exported; it is reachable through the controller module's own metadata.
  const Dto = (controllerModule as any).VerifyDocumentRequestDto
    ?? Reflect.getMetadata?.('design:paramtypes', controllerModule.AssayerController.prototype, 'verifyDocument')?.[1];

  /** The application's own settings — whitelist plus forbidNonWhitelisted is what produced the 400. */
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  const send = async (body: Record<string, unknown>) => pipe.transform(body, {
    type: 'body',
    metatype: Dto,
  });

  it('accepts the whole body, including the hash of the scan that was read', async () => {
    expect(Dto).toBeDefined();
    await expect(send({
      verdict: 'VERIFIED',
      holderName: 'Ramesh Iyer',
      holderDateOfBirth: '1986-04-12',
      holderGender: 'Male',
      targetVersionId: '48b5922f-b916-40a9-bdfc-84d4ec2e3d67',
      expectedDocVersion: 3,
      expectedContentHash: 'a'.repeat(64),
      remarks: 'Checked against the original.',
    })).resolves.toBeDefined();
  });

  it('accepts a send-back with its reason', async () => {
    await expect(send({
      verdict: 'REJECTED',
      rejectionReason: 'ILLEGIBLE',
      expectedContentHash: 'b'.repeat(64),
    })).resolves.toBeDefined();
  });

  /** The pipe still refuses a field nobody declared — this is not a licence to send anything. */
  it('still refuses a property that is genuinely not part of the request', async () => {
    await expect(send({ verdict: 'VERIFIED', somethingInvented: 'x' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a verdict that is not one', async () => {
    await expect(send({ verdict: 'MAYBE' })).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * The hash is optional: a document with no scan on file (verified from the paper original) sends
   * no hash, and must still be verifiable.
   */
  it('does not demand a hash for a document that has no scan', async () => {
    const value = plainToInstance(Dto, { verdict: 'VERIFIED', holderName: 'Ramesh Iyer' });
    expect(validateSync(value as object, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
  });
});
