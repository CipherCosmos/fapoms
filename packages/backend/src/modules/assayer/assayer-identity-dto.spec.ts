import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { AssayerController } from './assayer.controller';

/**
 * The identity-field gates on `POST /assayers` and `PUT /assayers/:id`.
 *
 * Until these decorators existed the two routes accepted ANY string into panNumber /
 * aadhaarNumber / ifscCode / phone — the roster importer was the only validation in the system,
 * so the form could store what the import refused. These tests run the REAL global pipe
 * configuration (main.ts) against the REAL classes bound to the routes — read off the route
 * metadata, exactly like `assayer-list-limit.spec.ts` reads the limit clamp — so swapping the
 * DTO class on the route, or deleting a decorator, fails here even though every unit test of the
 * validator functions stays green.
 */
describe('assayer DTO identity validation', () => {
  // The classes actually bound to the routes, via the design-time param types the pipe itself uses.
  const CreateDto = Reflect.getMetadata('design:paramtypes', AssayerController.prototype, 'create')?.[0];
  const UpdateDto = Reflect.getMetadata('design:paramtypes', AssayerController.prototype, 'update')?.[1];

  // Same options as app.useGlobalPipes(new ValidationPipe({ ... })) in main.ts.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  const runCreate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: CreateDto });
  const runUpdate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: UpdateDto });

  /** The messages of a refusal, or null when the body passed. */
  const refusalOf = async (promise: Promise<unknown>): Promise<string[] | null> => {
    try {
      await promise;
      return null;
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      const res = (e as BadRequestException).getResponse() as { message: string[] };
      return Array.isArray(res.message) ? res.message : [String(res.message)];
    }
  };

  const MINIMAL_CREATE = { firstName: 'Asha', lastName: 'Nair', state: 'Kerala' };

  it('binds the expected DTO classes to the routes (the metadata this whole file reads)', () => {
    expect(CreateDto?.name).toBe('CreateAssayerRequestDto');
    expect(UpdateDto?.name).toBe('UpdateAssayerRequestDto');
  });

  it('refuses a junk PAN on create with a message a clerk can act on', async () => {
    const messages = await refusalOf(runCreate({ ...MINIMAL_CREATE, panNumber: 'BAD' }));
    expect(messages).not.toBeNull();
    expect(messages!.join(' ')).toMatch(/PAN doesn't look right/);
    expect(messages!.join(' ')).toContain('ABCDE1234F');
  });

  it('accepts a well-formed create body, either case for PAN/IFSC', async () => {
    await expect(runCreate({
      ...MINIMAL_CREATE,
      panNumber: 'abcde1234f',
      ifscCode: 'sbin0001234',
      aadhaarNumber: '999941057058',
      phone: '+91 98765 43210',
    })).resolves.toBeInstanceOf(CreateDto);
  });

  /**
   * The masked round-trip: list responses show `******234F`, and a client that echoes that back
   * into an edit must be refused here — otherwise the mask overwrites the real number.
   */
  it('refuses a masked PAN and a masked Aadhaar', async () => {
    expect(await refusalOf(runUpdate({ panNumber: '******234F' }))).not.toBeNull();
    expect(await refusalOf(runUpdate({ aadhaarNumber: '********7058' }))).not.toBeNull();
  });

  describe('Aadhaar: shape, placeholder and checksum are told apart in the message', () => {
    it('wrong shape → says 12 digits', async () => {
      const messages = await refusalOf(runUpdate({ aadhaarNumber: 'Inactive' }));
      expect(messages!.join(' ')).toMatch(/12 digits/);
    });

    it('right shape, failed Verhoeff → says a digit is off, sends the clerk to the card', async () => {
      // 999941057058 is valid; the same digits with the last bumped must fail as a TYPO, not a shape.
      const messages = await refusalOf(runUpdate({ aadhaarNumber: '999941057059' }));
      expect(messages!.join(' ')).toMatch(/mistyped or swapped/);
    });

    /**
     * `999999999999` PASSES Verhoeff and is refused by the all-same-digit rule that runs ahead of
     * the checksum, so the "one digit looks mistyped" message was actively wrong for the value a
     * clerk is likeliest to type into a required field they cannot yet fill. Nothing is mistyped;
     * the number was never entered, and re-reading the card for a swapped digit finds nothing.
     */
    it('twelve identical digits → says placeholder, and never blames the checksum', async () => {
      const messages = await refusalOf(runUpdate({ aadhaarNumber: '999999999999' }));
      expect(messages).not.toBeNull();
      expect(messages!.join(' ')).toMatch(/placeholder/i);
      expect(messages!.join(' ')).not.toMatch(/mistyped or swapped/i);
    });

    it('uses the placeholder wording for all ten repeated digits, not only the nines', async () => {
      for (let d = 0; d <= 9; d++) {
        const messages = await refusalOf(runUpdate({ aadhaarNumber: String(d).repeat(12) }));
        expect(messages).not.toBeNull();
        expect(messages!.join(' ')).toMatch(/placeholder/i);
      }
    });

    it('still says "12 digits" for an eleven-digit repeat — that is a shape problem', async () => {
      const messages = await refusalOf(runUpdate({ aadhaarNumber: '99999999999' }));
      expect(messages!.join(' ')).toMatch(/12 digits/);
      expect(messages!.join(' ')).not.toMatch(/placeholder/i);
    });

    it('accepts a checksum-valid Aadhaar', async () => {
      await expect(runUpdate({ aadhaarNumber: '999941057058' })).resolves.toBeDefined();
    });
  });

  it('refuses an IFSC missing its reserved zero — payments to that code would fail', async () => {
    const messages = await refusalOf(runUpdate({ ifscCode: 'SBIN1001234' }));
    expect(messages!.join(' ')).toMatch(/IFSC code doesn't look right/);
  });

  it('refuses a phone that is not an Indian mobile, accepts every real spelling of one', async () => {
    expect(await refusalOf(runUpdate({ phone: '12345' }))).not.toBeNull();
    await expect(runUpdate({ phone: '09876543210' })).resolves.toBeDefined();
    await expect(runUpdate({ phone: '+91 98765-43210' })).resolves.toBeDefined();
  });

  /**
   * THE LEGACY-DATA GUARANTEE. 1,128 stored PANs and 578 Aadhaars predate validation; plenty are
   * junk. The DTO layer judges only the keys present in the request body — it never reads the
   * stored row — so correcting an unrelated field on a record with a bad legacy PAN must go
   * through. If this ever fails, every record with historical junk becomes uneditable, which
   * would punish exactly the people trying to clean the data.
   */
  it('does not block an update that never mentions the identity fields', async () => {
    await expect(runUpdate({ city: 'Pune' })).resolves.toBeDefined();
    await expect(runUpdate({ notes: 'Reachable after 5pm' })).resolves.toBeDefined();
  });

  /**
   * Clearing IS how junk gets removed. The web edit form sends `""` for an emptied box
   * (`buildAssayerEditBody`), so an empty string must pass the format gate — refusing it would
   * make a bad legacy value permanent.
   */
  it('accepts an empty string as "clear this field"', async () => {
    await expect(runUpdate({ panNumber: '' })).resolves.toBeDefined();
    await expect(runUpdate({ aadhaarNumber: '', ifscCode: '', phone: '' })).resolves.toBeDefined();
  });

  it('skips null the same way (@IsOptional covers both null and absent)', async () => {
    await expect(runUpdate({ panNumber: null as unknown as string })).resolves.toBeDefined();
  });
});
