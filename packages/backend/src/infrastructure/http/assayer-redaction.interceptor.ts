import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { redactAssayersDeep, rolesOf } from '../../modules/assayer/assayer-visibility';

/**
 * Assayer identity and banking never leave the system to a role that may not read them —
 * whichever route the response came out of.
 *
 * `scopeAssayerForRoles` guarded the four assayer endpoints and nothing else, while the assayer
 * record is joined into schedules, assignments, the operations inbox, documents and
 * clarification threads. Because `pan_number` and `bank_account_number` decrypt on entity load,
 * every one of those joins handed a PAN and a bank account to DESK, DESK_OPERATOR and AUDITOR —
 * the exact roles the policy exists to keep them from. The front door was locked and a dozen
 * side windows were open, and each one was a separate thing to remember.
 *
 * Doing it here instead means the rule is applied once, at the boundary, and a route added
 * tomorrow that joins an assayer is covered without anyone thinking about it. The alternative —
 * a redaction call in each service — is the arrangement that produced the gap.
 *
 * The walk runs for every role, full access included. It used to return early for ADMIN and
 * OPERATIONS — correct while the policy only stripped fields, since there was nothing to strip
 * from a role that may read everything. The policy now also masks PAN, Aadhaar and bank account
 * down to their last four digits, and those two roles are precisely the ones that still receive
 * those fields, so they are the only roles the masking has anything to do to. Restoring the short
 * circuit would hand them the whole numbers again on every route this interceptor covers. The
 * reasoning is set out at length under "## Why the full-access short circuit is gone" in
 * `assayer-visibility.ts`; read that before making this cheaper.
 *
 * The one deliberate limit that remains: this strips and masks fields; it does not decide
 * *whether* a caller may see a record at all. That is still the job of the guards and the scope.
 */
@Injectable()
export class AssayerRedactionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const roles = rolesOf(req?.user);
    // An unauthenticated route has no principal to judge against. Those are public by
    // declaration and must not be serving assayer records; if one ever did, redacting on an
    // empty role list is the safe direction anyway.
    const selfId: string | undefined = req?.user?.id;

    return next.handle().pipe(
      map((body) => {
        // A file download is a stream, not a graph — walking it would consume it.
        if (body instanceof StreamableFile || body == null || typeof body !== 'object') return body;
        return redactAssayersDeep(body, roles, selfId);
      }),
    );
  }
}
