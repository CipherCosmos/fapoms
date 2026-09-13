import { validate, IsOptional, IsString, MaxLength, ValidateBy } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { isGstinOrPan, GSTIN_OR_PAN_REFUSAL, ContractStatus } from '@fapoms/shared';
import { UpdateContractRequestDto } from './client.controller';

/**
 * `taxId` on the client DTOs (`CreateClientRequestDto` / `UpdateClientRequestDto` in
 * `client.controller.ts`) used to be `@IsOptional() @IsString() @MaxLength(100)` and nothing
 * else — the only field on the client API with an identity-shaped placeholder ("e.g., GSTIN /
 * PAN", see `EditClientModal.tsx`) and no format check, unlike every identity field on the
 * assayer DTOs (PAN, IFSC, Aadhaar all have one). Anything up to 100 characters was accepted and
 * stored, including a masked value echoed back from a list view.
 *
 * The decorator is still declared here rather than imported, because it is module-private in
 * `client.controller.ts` — the same reasoning `coded-validation.pipe.spec.ts` uses for its own
 * local copy of `IsPanFormat`. What it wraps no longer is: the rule and its sentence are
 * `isGstinOrPan` and `GSTIN_OR_PAN_REFUSAL` in `@fapoms/shared`, which is also what the client
 * edit form now checks before it lets the operator press Save. This copy therefore pins the
 * mapping from the constraint NAME to the shared rule, and cannot restate the rule wrongly.
 */
const IsGstinOrPanFormat = () => ValidateBy({
  name: 'isGstinOrPanFormat',
  validator: { validate: isGstinOrPan, defaultMessage: () => GSTIN_OR_PAN_REFUSAL },
});

class TaxIdDto {
  @IsOptional() @IsString() @MaxLength(100) @IsGstinOrPanFormat()
  taxId?: string;
}

async function errorsFor(taxId: unknown) {
  const dto = plainToInstance(TaxIdDto, { taxId });
  return validate(dto);
}

describe('client taxId: GSTIN-or-PAN format', () => {
  it('accepts a real GSTIN', async () => {
    expect(await errorsFor('27AAPFU0939F1ZV')).toHaveLength(0);
  });

  it('accepts a real PAN', async () => {
    expect(await errorsFor('ABCDE1234F')).toHaveLength(0);
  });

  it('accepts either case and surrounding whitespace, same as the underlying validators', async () => {
    expect(await errorsFor('27aapfu0939f1zv')).toHaveLength(0);
    expect(await errorsFor('  abcde1234f  ')).toHaveLength(0);
  });

  it('accepts an absent or empty value — the field is optional and must stay clearable', async () => {
    expect(await errorsFor(undefined)).toHaveLength(0);
    expect(await errorsFor('')).toHaveLength(0);
  });

  /**
   * The case a length check alone cannot catch: a 15-character string, the exact length of a
   * real GSTIN, that is neither a GSTIN nor a PAN. Proves the rule actually inspects the shape
   * (and, for a GSTIN-length value, the checksum) rather than just bounding `@MaxLength`.
   */
  it('rejects a garbage string the same length as a real GSTIN', async () => {
    const errors = await errorsFor('NOTAREALVALUE12');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isGstinOrPanFormat');
  });

  it('rejects a garbage string the same length as a real PAN', async () => {
    const errors = await errorsFor('NOTAPAN123');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isGstinOrPanFormat');
  });

  it('rejects a right-shape GSTIN whose checksum does not hold — shape alone must not be enough', async () => {
    // 27AAPFU0939F1ZV is the real, checksum-valid GSTIN used above; flipping only the last
    // character keeps the shape intact and breaks only the checksum.
    const errors = await errorsFor('27AAPFU0939F1ZA');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isGstinOrPanFormat');
  });

  it('rejects a masked value echoed back from a list view', async () => {
    const errors = await errorsFor('******F1ZV');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isGstinOrPanFormat');
  });

  it('still enforces the length bound independently of the format rule', async () => {
    const errors = await errorsFor('A'.repeat(101));
    const names = errors.flatMap((e) => Object.keys(e.constraints ?? {}));
    expect(names).toContain('maxLength');
  });
});

/**
 * `UpdateContractRequestDto.status` used to be `@IsOptional() @IsString()` against the real
 * `ContractStatus` enum `ContractsPanel.tsx` displays. There is no edit-contract UI today (the
 * panel only adds and removes contracts — confirmed by reading the whole file, no PUT call
 * exists), so this is provably non-breaking for the current frontend: nothing sends `status` to
 * this endpoint at all. It only closes the gap for a direct/malformed API call.
 */
describe('UpdateContractRequestDto.status', () => {
  const errorsFor = async (status: unknown) => {
    const dto = plainToInstance(UpdateContractRequestDto, { status });
    return validate(dto);
  };

  it.each(Object.values(ContractStatus))('accepts the real ContractStatus member %s', async (status) => {
    expect(await errorsFor(status)).toHaveLength(0);
  });

  it('accepts an absent status — no current flow sends one', async () => {
    const dto = plainToInstance(UpdateContractRequestDto, {});
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a garbage status string', async () => {
    const errors = await errorsFor('SUSPENDED');
    expect(errors.some((e) => e.property === 'status' && e.constraints?.isEnum)).toBe(true);
  });
});
