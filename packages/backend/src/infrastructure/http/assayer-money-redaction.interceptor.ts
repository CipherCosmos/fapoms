import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SystemRole } from '@fapoms/shared';
import { rolesOf } from '../../modules/assayer/assayer-visibility';
import { STAFF_ROLES } from '../../modules/auth/staff-roles';

/**
 * The assayer sees no money, whichever route the response came out of.
 *
 * The business decision (2026-09): fees are an ops-internal fact, settled with the operations
 * desk by phone, and the field app shows them nowhere — not on the offer, not on the schedule,
 * not in a transition response. The assayer first sees money when operations invites them to
 * submit an invoice, and that reveal uses the payable field names
 * (`baseAmount`/`travelAmount`/`tdsAmount`/`totalAmount`), so nothing this interceptor strips
 * collides with it.
 *
 * Done here, at the boundary, and not per-route — deliberately. Per-route stripping is the
 * pattern that produced the region-scope gaps and the PII gap the sibling
 * `AssayerRedactionInterceptor` exists to close: `GET /assignments/assayer/:id`,
 * `GET /assignments/:id`, every transition response and every join that carries an assignment
 * each returned the raw fee columns, and each was a separate thing to remember. One walk at
 * the boundary covers the route added tomorrow without anyone thinking about it.
 *
 * Unlike the PII interceptor's policy (which targets nodes that ARE assayer records), the fee
 * keys are deleted from EVERY object node: fee columns live on the assignment row, but they
 * are joined into schedules, work lists and inbox shapes under whatever name the relation has,
 * and a key-by-key strip is the only rule that holds wherever the row lands.
 *
 * What is deliberately KEPT: `quotedDistanceKm`/`quotedTransportMode` (operational facts — how
 * far, by what — with no rupee figure derivable from them), and every staff/mixed-role
 * response. A principal holding any staff role sees full money whether or not they also hold
 * ASSAYER; the blinding is for assayer-only principals, i.e. the field app's own tokens.
 */

/** The assignment fee columns, everywhere they appear, whatever the parent object is called. */
export const ASSAYER_MONEY_FIELDS = [
  'proposedFee',
  'agreedFee',
  'quotedBaseFee',
  'quotedTravelFee',
  'counterTravelFee',
  'negotiationCount',
  'lastCounterRequestId',
] as const;

/**
 * True only for a principal whose roles include ASSAYER and no staff role. `rolesOf` normalises
 * the two `req.user.roles` shapes (RoleEntity rows for staff logins, plain `{ name }` for
 * assayer tokens) exactly as the PII interceptor does; `STAFF_ROLES` is the same list the
 * controllers gate on, so "staff" means the same thing at this boundary as at every other.
 */
export function isMoneyBlindPrincipal(user: any): boolean {
  const roles = rolesOf(user);
  return roles.includes(SystemRole.ASSAYER) && !roles.some((r) => (STAFF_ROLES as string[]).includes(r));
}

/**
 * Delete the fee keys from every object node of a payload, arrays included.
 *
 * Same mechanics as `redactAssayersDeep` (which this deliberately mirrors — see that function
 * for the reasoning at length): edited in place because TypeORM graphs alias the same row from
 * several places and replacing one reference would leave the others unredacted; a WeakSet
 * guards the parent↔child cycles TypeORM hands back; Dates and Buffers carry nothing to
 * redact and copying them would break their prototypes.
 */
export function redactAssignmentMoneyDeep<T>(payload: T): T {
  const seen = new WeakSet<object>();

  const walk = (node: any): any => {
    if (node === null || typeof node !== 'object') return node;
    if (seen.has(node)) return node;
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
      return node;
    }

    if (node instanceof Date || Buffer.isBuffer(node)) return node;

    for (const key of ASSAYER_MONEY_FIELDS) {
      if (key in node) delete node[key];
    }

    for (const key of Object.keys(node)) node[key] = walk(node[key]);
    return node;
  };

  return walk(payload);
}

@Injectable()
export class AssayerMoneyRedactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    // Unlike the PII walk (whose masking has work to do for every role), staff responses need
    // nothing from this policy — the desk's whole job is the money — so the walk only runs for
    // the principal it exists for. An unauthenticated route has no ASSAYER role and passes.
    if (!isMoneyBlindPrincipal(req?.user)) return next.handle();

    return next.handle().pipe(
      map((body) => {
        // A file download is a stream, not a graph — walking it would consume it.
        if (body instanceof StreamableFile || body == null || typeof body !== 'object') return body;
        return redactAssignmentMoneyDeep(body);
      }),
    );
  }
}
