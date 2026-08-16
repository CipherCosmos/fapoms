import { Injectable, PipeTransform, ArgumentMetadata } from '@nestjs/common';

/**
 * Trim every incoming string before validation runs.
 *
 * `@IsNotEmpty()` rejects `""` but happily accepts `"   "`, and the browser's `required`
 * attribute does the same — so a field of spaces satisfied both layers and was stored verbatim.
 * That produced records nobody can identify or act on, in five separate modules before this was
 * fixed centrally:
 *
 *  - a client with code/name/display of `"   "`, which then appeared in every downstream client
 *    picker as a selectable "( )";
 *  - a project whose name rendered as a blank row in the projects list;
 *  - a *user* whose username — the login identifier — was three spaces, shown in the staff
 *    directory as a bare "@";
 *  - a zone and a holiday with blank names, both of which feed scheduling rules.
 *
 * Fixing it per-DTO meant 20 controllers and a standing invitation to miss the next one, so it is
 * done once here, ahead of the global `ValidationPipe`. Trimming is the right default for HTTP
 * input generally: leading and trailing whitespace in a JSON body is almost always an accident of
 * copy-paste, never meaningful data.
 *
 * Deliberately narrow:
 *  - only strings are touched; numbers, booleans, dates and nulls pass through untouched;
 *  - a string that trims to empty becomes `""` rather than being deleted, so `@IsNotEmpty()` is
 *    the thing that reports it and the error message still names the field;
 *  - `password` is exempt — leading/trailing spaces can be deliberate in a passphrase, and
 *    silently altering a credential would lock someone out of an account they set up correctly.
 */
@Injectable()
export class TrimStringsPipe implements PipeTransform {
  /** Fields whose surrounding whitespace may be intentional and must survive untouched. */
  private static readonly EXEMPT = new Set(['password', 'newPassword', 'currentPassword', 'confirmPassword']);

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    return this.trim(value);
  }

  private trim(value: unknown, key?: string): unknown {
    if (typeof value === 'string') {
      return key && TrimStringsPipe.EXEMPT.has(key) ? value : value.trim();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.trim(item));
    }
    // Plain objects only. Dates, Buffers and class instances (an uploaded file, for one) must
    // pass through as themselves rather than being rebuilt into a bare object.
    if (value !== null && typeof value === 'object' && (value as object).constructor === Object) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.trim(v, k);
      }
      return out;
    }
    return value;
  }
}
