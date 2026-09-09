/**
 * Re-export only. The number itself now lives in `@fapoms/shared`, because the transition modals
 * need it too and the frontend cannot import from this package — see the docblock there.
 *
 * This file stays so the two importers in this module keep their local path, and so the next
 * person looking for the limit where it used to be finds the forwarding address instead of
 * nothing.
 */
export { LIFECYCLE_REASON_MAX_LENGTH } from '@fapoms/shared';
