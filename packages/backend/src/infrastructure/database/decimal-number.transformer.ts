import type { ValueTransformer } from 'typeorm';

/**
 * Postgres `numeric`/`decimal` columns arrive from the driver as STRINGS ("18.5204303"), so an
 * entity typed `number | null` was lying: branch and assayer coordinates reached the planning
 * screen as strings, and `POST /geo/route/optimize` (whose DTO says `@IsNumber()`) refused the
 * "Optimize route" payload the browser built from them. Coordinates are read as numbers everywhere
 * they are used, so they are converted once, here, at the column.
 *
 * Money decimals are deliberately NOT given this transformer — they are summed with care by the
 * billing code and a float there is a different decision.
 *
 * Null stays null; an unparsable value becomes null rather than NaN (NaN would pass `!= null`
 * checks and poison every distance computed from it).
 */
export const decimalNumberTransformer: ValueTransformer = {
  to: (value: unknown) => value,
  from: (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  },
};
