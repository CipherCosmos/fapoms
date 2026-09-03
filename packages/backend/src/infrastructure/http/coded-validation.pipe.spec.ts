import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { isValidPan } from '@fapoms/shared';
import { CodedValidationPipe } from './coded-validation.pipe';

/**
 * A DTO refusal was the one failure the mobile app could not translate at all.
 *
 * Everything else it shows is a fixed sentence it can match; a validation error is an array of
 * English strings class-validator assembles from decorator metadata, different for every DTO,
 * with the property name buried in the prose. There is nothing stable to match — so the failures
 * a person is most able to fix themselves were the ones they were least likely to understand.
 *
 * Two things are asserted here, and the first matters more than the second: that `message` is
 * still exactly what it was, and that `fields` says which input was at fault.
 */

// Mirrors the four custom identity rules in assayer.controller.ts. Declared here rather than
// imported because they are module-private there; what this pins down is the mapping from the
// constraint NAME, which is the part that has to agree.
const IsPanFormat = () => ValidateBy({
  name: 'isPanFormat',
  validator: {
    validate: (value: unknown) => typeof value === 'string' && isValidPan(value),
    defaultMessage: () => "This PAN doesn't look right — it should be 5 letters, 4 digits, 1 letter, like ABCDE1234F.",
  },
});

class AddressDto {
  @IsString() @IsNotEmpty()
  city!: string;
}

class ProfileDto {
  @IsString() @IsNotEmpty() @MaxLength(5)
  name!: string;

  @IsOptional() @IsInt() @Max(10)
  rank?: number;

  @IsOptional() @IsString() @IsPanFormat()
  panNumber?: string;

  @IsOptional() @ValidateNested() @Type(() => AddressDto)
  address?: AddressDto;
}

const OPTIONS = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
};

const meta = { type: 'body', metatype: ProfileDto } as const;

async function refusalFrom(pipe: ValidationPipe, body: unknown): Promise<BadRequestException> {
  try {
    await pipe.transform(body, meta as never);
  } catch (error) {
    return error as BadRequestException;
  }
  throw new Error('expected the pipe to refuse this body');
}

describe('CodedValidationPipe', () => {
  const coded = new CodedValidationPipe(OPTIONS);
  /** The stock pipe, same options — the baseline every message assertion compares against. */
  const stock = new ValidationPipe(OPTIONS);

  /**
   * The load-bearing test.
   *
   * A code is an ADDITION. Several of these sentences were written for a non-technical reader,
   * the web app renders the array directly, and the English is the fallback for any client with
   * no translation for a code yet. Comparing against a stock pipe rather than against a
   * hand-written expectation is deliberate: a hand-written one would have to be updated whenever
   * class-validator changes its wording, and would then be asserting this file's opinion of the
   * message rather than the fact that the message did not change.
   */
  it.each([
    ['a missing required field', { }],
    ['several failures at once', { name: 'far too long', rank: 99 }],
    ['a nested object', { name: 'ok', address: { city: '' } }],
    ['a property the endpoint does not accept', { name: 'ok', nonsense: 1 }],
    ['a custom identity rule', { name: 'ok', panNumber: 'NOTAPAN' }],
  ])('returns the same message as the stock pipe for %s', async (_case, body) => {
    const [mine, theirs] = await Promise.all([
      refusalFrom(coded, body),
      refusalFrom(stock, body),
    ]);

    const message = (b: BadRequestException) => (b.getResponse() as { message: unknown }).message;
    expect(message(mine)).toEqual(message(theirs));
    expect(mine.getStatus()).toBe(theirs.getStatus());
  });

  it('names the failure and stays a BadRequestException', async () => {
    const refusal = await refusalFrom(coded, {});

    expect(refusal).toBeInstanceOf(BadRequestException);
    expect(refusal.getResponse()).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
    });
  });

  /**
   * The property path is kept as data rather than left embedded in the English.
   *
   * Nest's own flattening prefixes the path onto the sentence (`address.city must be a string`),
   * which leaves a client parsing prose to discover which input to mark. A form can address
   * `address.city`; it cannot address a substring of a translated apology.
   */
  it('reports the dotted path of a nested field', async () => {
    const refusal = await refusalFrom(coded, { name: 'ok', address: { city: '' } });
    const { fields } = refusal.getResponse() as { fields: Array<{ field: string; code: string }> };

    expect(fields.map((f) => f.field)).toContain('address.city');
  });

  it.each([
    [{ }, 'name', 'REQUIRED'],
    [{ name: 'far too long' }, 'name', 'TOO_LONG'],
    [{ name: 'ok', rank: 99 }, 'rank', 'OUT_OF_RANGE'],
    [{ name: 'ok', panNumber: 'NOTAPAN' }, 'panNumber', 'BAD_PAN'],
    [{ name: 'ok', nonsense: 1 }, 'nonsense', 'UNKNOWN_FIELD'],
  ])('codes %j as %s → %s', async (body, field, code) => {
    const refusal = await refusalFrom(coded, body);
    const { fields } = refusal.getResponse() as { fields: Array<{ field: string; code: string }> };

    expect(fields).toContainEqual(expect.objectContaining({ field, code }));
  });

  /**
   * One entry per failed constraint, not per field. A missing string fails `@IsString()` and
   * `@IsNotEmpty()` together, and collapsing them would drop one of the two arbitrarily — the
   * client would then be told the value was the wrong type when what it actually needs to say is
   * that the field is required.
   */
  it('keeps every constraint a single field failed', async () => {
    const refusal = await refusalFrom(coded, {});
    const { fields } = refusal.getResponse() as { fields: Array<{ field: string; code: string }> };
    const forName = fields.filter((f) => f.field === 'name');

    expect(forName.length).toBeGreaterThan(1);
    expect(forName.map((f) => f.code)).toContain('REQUIRED');
  });

  it("carries class-validator's own English on each field, as the fallback", async () => {
    const refusal = await refusalFrom(coded, { name: 'ok', panNumber: 'NOTAPAN' });
    const { fields } = refusal.getResponse() as { fields: Array<{ field: string; message: string }> };

    expect(fields.find((f) => f.field === 'panNumber')?.message)
      .toBe("This PAN doesn't look right — it should be 5 letters, 4 digits, 1 letter, like ABCDE1234F.");
  });

  it('lets a valid body through untouched', async () => {
    await expect(coded.transform({ name: 'ok' }, meta as never)).resolves.toMatchObject({ name: 'ok' });
  });
});
