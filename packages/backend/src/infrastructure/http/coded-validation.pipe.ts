import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError, ValidationPipeOptions } from '@nestjs/common';
import { GENERAL_ERROR_CODES } from '@fapoms/shared';
import { fieldErrorsFrom, withCode } from './api-error';

/**
 * The global `ValidationPipe`, plus the one thing a translated client needs from it: which field.
 *
 * A DTO refusal is the failure the mobile app could never translate. Everything else it shows is
 * at least a fixed sentence it can match on; this one arrives as an array of English strings
 * assembled by class-validator from decorator metadata, different for every DTO, with the
 * property name embedded in the prose (`address.city must be a string`). There is nothing stable
 * to match, so every validation failure on a phone is English — and validation failures are the
 * ones a person can actually fix themselves, which makes them the worst ones to leave untranslated.
 *
 * What changes: the 400 body gains `code: 'VALIDATION_FAILED'` and a `fields` array of
 * `{ field, code, message }`. What does not change: `message`. It is still produced by Nest's own
 * `flattenValidationErrors`, called below rather than reimplemented, so the array is identical
 * string-for-string to what this endpoint returned before — the web app renders it directly and
 * a client with no `fields` support is unaffected.
 */
export class CodedValidationPipe extends ValidationPipe {
  constructor(options?: ValidationPipeOptions) {
    super(options);
  }

  /**
   * Nest calls this during construction to build `this.exceptionFactory`, so overriding it is
   * how a subclass gets at the raw `ValidationError[]`. Passing `exceptionFactory` through the
   * options would work equally well but would put the codes somewhere other than the pipe that
   * owns them, and `flattenValidationErrors` is protected — reachable only from in here.
   */
  override createExceptionFactory(): (errors?: ValidationError[]) => unknown {
    return (errors: ValidationError[] = []) => {
      const exception = withCode(
        new BadRequestException(this.flattenValidationErrors(errors)),
        GENERAL_ERROR_CODES.VALIDATION_FAILED,
      );

      /**
       * Only when there is something to say. `forbidNonWhitelisted` can reject a payload with a
       * validation error that carries no constraints at all, and an empty `fields: []` reads to a
       * client as "no field was at fault", which is a stronger claim than "we could not tell you
       * which". Omitting the key leaves the message as the only account of it, which is honest.
       */
      const fields = fieldErrorsFrom(errors);
      if (fields.length > 0) {
        Object.assign(exception.getResponse() as object, { fields });
      }

      return exception;
    };
  }
}
