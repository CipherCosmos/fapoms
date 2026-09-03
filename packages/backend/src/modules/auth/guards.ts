/**
 * FAPOMS — Authorization Guards
 *
 * Implements the authorization flow per Part 8 §16:
 * 1. JwtAuthGuard — authenticate (validate JWT)
 * 2. RolesGuard — check RBAC roles
 * 3. PermissionsGuard — check granular permissions (resource:action:scope)
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  SetMetadata,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AUTH_ERROR_CODES } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';

// ---------------------------------------------------------------------------
// JWT Authentication Guard & Public Decorator
// ---------------------------------------------------------------------------

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Marks the few routes a user with an unchanged issued password may still reach.
 *
 * A user still on a password someone else set (a seeded credential, an admin reset) is forced to
 * change it before doing anything else — see the enforcement in `JwtAuthGuard`. That forcing is
 * only real if the change itself, reading their own profile to know they must change it, and
 * signing out remain reachable; every other route is refused. This decorator names those
 * exceptions.
 */
export const PASSWORD_CHANGE_EXEMPT_KEY = 'passwordChangeExempt';
export const PasswordChangeExempt = () => SetMetadata(PASSWORD_CHANGE_EXEMPT_KEY, true);

/**
 * Marks the routes an assayer may reach while still registering.
 *
 * The four onboarding stages can sign in so they can finish their own registration from a phone —
 * photographing their Aadhaar rather than carrying it to the office. They are not on duty and
 * have not been vetted: background verification is one of the stages listed. The ASSAYER role by
 * itself reaches nine controllers, including assignments, documents, expenses and billing, so
 * granting the session without narrowing it would hand all of that to someone whose checks are
 * still outstanding.
 *
 * So the rule is deny-by-default and the exceptions are named here, rather than the reverse. That
 * ordering is the point: a route added tomorrow is closed to these sessions until somebody
 * decides otherwise, instead of being open until somebody notices. The failure mode of getting
 * the list wrong is an assayer told to ring the office, not a stranger reading a branch address.
 */
export const ONBOARDING_ALLOWED_KEY = 'onboardingAllowed';
export const OnboardingAllowed = () => SetMetadata(ONBOARDING_ALLOWED_KEY, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector?: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector) {
      const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (isPublic) {
        return true;
      }
    }

    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;

    /**
     * Forced password change, enforced HERE rather than trusted to the browser.
     *
     * `mustChangePassword` was returned to the client and acted on only by the web app, which
     * routes such a user to the change-password screen. But the access token they hold carries
     * full permissions, so anyone who ignored the UI — a curl script, the mobile client, a stale
     * tab — used the API normally with a password an admin set or the system seeded. For an
     * account still on `admin123` that is a straight path to whatever the account can do. The
     * check now lives in the guard every authenticated route passes through, so the UI can no
     * longer be the only thing standing between a shared default and the API.
     *
     * Enforced for BOTH principal kinds. Staff (`UserEntity`) always carried the flag; the
     * assayer mobile principal did not, which exempted the entire field workforce — the group
     * the rule matters most for, since the bulk import seeded one shared default password and
     * every HR reset issues a staff-known temporary one. `validateJwtPayload` now puts the flag
     * on assayer principals too, so both are held to it here.
     *
     * The exempt routes stay open so the forcing cannot trap anyone: change-password and the
     * own-profile read for each principal kind (`/users/me`* for staff, `/assayers/me/
     * change-password` and `/assayers/:id/profile` for the field app — the profile read is also
     * how the mobile app LEARNS the flag on a restored session, and its `validateSession` treats
     * a 401/403 there as "session dead, sign out", so refusing it would eject the user instead
     * of routing them to the change screen), plus logout.
     */
    if (this.reflector) {
      const exempt = this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_EXEMPT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!exempt) {
        const user = context.switchToHttp().getRequest()?.user;
        if (user?.mustChangePassword === true) {
          /**
           * Machine-readable discriminator, because this 403 means "come back after one
           * specific action", not "you may never do this". Clients that switch on status
           * alone can mistake it for a dead session or a permissions problem; `code` lets
           * them route to the change-password screen instead. The human-readable message
           * is unchanged for anything already displaying it.
           *
           * This was the first code in the system and spelled its body out by hand. It now goes
           * through `withCode` and the shared vocabulary like every other coded error — the wire
           * value is identical, deliberately, because shipped app builds compare against this
           * exact literal.
           */
          throw withCode(
            new ForbiddenException(
              'You must change your password before you can continue. Please set a new password.',
            ),
            AUTH_ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
          );
        }
      }

      /**
       * A registration-only session may go no further than registering.
       *
       * Checked after the forced-password-change gate above, because an assayer who has just been
       * invited has both conditions true at once and must be sent to the password screen first —
       * telling them their registration is incomplete when what actually blocks them is an
       * unchanged password would send them to their HR contact for something they can fix
       * themselves.
       */
      const onboardingAllowed = this.reflector.getAllAndOverride<boolean>(ONBOARDING_ALLOWED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!onboardingAllowed) {
        const user = context.switchToHttp().getRequest()?.user;
        if (user?.onboarding === true) {
          // Lets the app show the registration checklist rather than a dead end, and keeps this
          // apart from PASSWORD_CHANGE_REQUIRED, which needs a different screen.
          throw withCode(
            new ForbiddenException(
              'You can finish your registration here. Your HR contact will open the rest of the app once your joining checks are done.',
            ),
            AUTH_ERROR_CODES.REGISTRATION_IN_PROGRESS,
          );
        }
      }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Role-Based Access Control (RBAC) Guard
// ---------------------------------------------------------------------------

export const ROLES_KEY = 'roles';
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const ANY_AUTHENTICATED_KEY = 'anyAuthenticated';
/**
 * Marks a route as deliberately available to every signed-in principal, whatever their role.
 *
 * Use this ONLY where that is genuinely correct — a user reading or changing their own
 * profile, shared reference data such as the state/district list, a person's own notifications.
 * It exists so that "open to all authenticated users" is an explicit, greppable, reviewable
 * decision rather than the silent consequence of forgetting a decorator.
 */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED_KEY, true);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    /**
     * `@Public()` is honoured here as well as in JwtAuthGuard.
     *
     * Only JwtAuthGuard checked it, so on any controller that also applies this guard a public
     * route passed authentication and was then refused by the deny-by-default rule below —
     * always 403, never reachable. That is why signed attachment links could not be opened:
     * the download route is deliberately public and token-authenticated, and this guard
     * rejected it before the handler ever ran.
     *
     * The deny-by-default posture is unchanged for every route that is not explicitly public.
     */
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    /**
     * DENY BY DEFAULT.
     *
     * This previously did `return true` when a route carried no @Roles metadata, which meant a
     * controller that put @UseGuards at the class level but annotated only *some* of its
     * handlers silently left the rest open to every authenticated principal — including a field
     * ASSAYER, whose token is issued from the `assayers` table. ~50 handlers were in that state,
     * among them every billing read (exposing other assayers' payouts and the bank's invoices),
     * `customer-master` borrower records, `GET /users/:id`, and `PUT /assayers/:id/live`.
     *
     * The failure mode is the dangerous direction: forgetting a decorator granted access rather
     * than refusing it, and nothing in the code looked wrong. Routes must now state their
     * audience — either @Roles(...), or @AnyAuthenticated() where open access is intended, or
     * @Public() for genuinely unauthenticated endpoints.
     */
    if (!requiredRoles || requiredRoles.length === 0) {
      const anyAuthenticated = this.reflector.getAllAndOverride<boolean>(
        ANY_AUTHENTICATED_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (anyAuthenticated) {
        return true;
      }
      throw new ForbiddenException(
        'This action is not available to your role. If you believe it should be, ask an administrator to review your access.',
      );
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.roles) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const userRoles = user.roles.map((r: { name: string }) => r.name);
    if (requiredRoles.some((role) => userRoles.includes(role))) return true;

    /**
     * A role this route never heard of still gets in, if it holds the permissions the route asks
     * for.
     *
     * Every route names the built-in roles it serves — `@Roles(ADMIN, OPERATIONS)` and so on — and
     * that list is a closed set written in code. A role built in Admin → Roles is a database row
     * with no entry in `SystemRole`, so its name matched nothing and this guard refused it before
     * `PermissionsGuard` ever saw the permissions somebody had deliberately attached to it. The
     * administrator screen offered a role builder that could not grant access to anything, and the
     * refusal read "Insufficient role permissions" while the permissions were sitting right there.
     *
     * So the name is now a shortcut, not the whole rule: match it and you are in, exactly as
     * before — no existing role gains or loses anything — and otherwise the question becomes
     * whether you hold what the route requires.
     *
     * FAIL CLOSED, and this is the part to keep. A route that declares no `@RequirePermissions`
     * offers nothing to check, so an unrecognised role is still refused. That is deliberate: the
     * alternative — treating "nothing declared" as "nothing required" — is the exact defect the
     * deny-by-default note above records, where a missing decorator granted access instead of
     * withholding it. `route-permission-parity.spec.ts` is what stops routes staying in that
     * state; it lists every role-gated route that declares no permission.
     *
     * `every`, not `some`: holding one of three required permissions is not holding what the route
     * asked for, and `PermissionsGuard` downstream applies the same rule to the same list.
     */
    // A route may opt out of the fall-through entirely — see `@RoleOnly()`.
    const roleOnly = this.reflector.getAllAndOverride<boolean>(
      ROLE_ONLY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredPermissions = roleOnly ? undefined : this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredPermissions?.length) {
      const held = permissionKeysHeldBy(user);
      // `toUpperCase` because routes declare these in lower case (`assayer:view:organization`)
      // while the stored rows are upper case — the same normalisation PermissionsGuard applies.
      if (requiredPermissions.every((perm) => held.has(perm.toUpperCase()))) return true;
    }

    throw new ForbiddenException('Insufficient role permissions');
  }
}

// ---------------------------------------------------------------------------
// Permission-Based Access Control Guard
// ---------------------------------------------------------------------------

/**
 * Every permission key this principal holds, in the form routes declare them.
 *
 * Extracted because two guards now ask the question. `PermissionsGuard` has always asked it;
 * `RolesGuard` began asking when a role built in the admin screen — which matches no name in
 * `SystemRole` — needed a way to be recognised by what it can do rather than what it is called.
 * Two copies of a rule with a scope-widening table in it would not have stayed in step, and the
 * failure would have been silent in the dangerous direction: one guard admitting a principal the
 * other refuses.
 *
 * The widening is the part worth reading. A PLATFORM-scoped permission implies the same
 * resource/action at every narrower scope, so somebody granted `assayer:edit:platform` satisfies a
 * route asking for `assayer:edit:organization`. Written out rather than computed so the set of
 * scopes is visible at the point it matters.
 */
export function permissionKeysHeldBy(user: any): Set<string> {
  const NARROWER_THAN_PLATFORM = [
    'ORGANIZATION', 'CLIENT', 'STATE', 'REGION', 'DEPARTMENT', 'TEAM', 'SELF',
  ];
  const held = new Set<string>();
  for (const role of user?.roles ?? []) {
    for (const perm of role?.permissions ?? []) {
      held.add(`${perm.resource}:${perm.action}:${perm.scope}`);
      if (perm.scope === 'PLATFORM') {
        for (const scope of NARROWER_THAN_PLATFORM) {
          held.add(`${perm.resource}:${perm.action}:${scope}`);
        }
      }
    }
  }
  return held;
}

/**
 * Marks a route whose `@Roles(...)` list is the whole gate, with no permission fall-through.
 *
 * `RolesGuard` normally lets an unrecognised role in when it holds what the route declares — that
 * is what makes a role built in Admin → Roles mean anything. A few routes cannot work that way,
 * because their permission is deliberately the SAME as a broader route's and the narrow `@Roles`
 * list is the only thing separating them.
 *
 * The audited PII reveal is the case that produced this decorator. It returns a full PAN, Aadhaar
 * or bank account, and it declares `assayer:view:organization` — the same permission as reading
 * the masked record, chosen so the two cannot drift apart. Its own comment said "what actually
 * holds the line here is the narrow @Roles list", which was exactly true while names were the only
 * gate. The moment permissions became authoritative, granting three roles the ordinary roster read
 * also handed them the reveal. This restores the line the comment describes.
 *
 * Use it sparingly and only where a permission genuinely cannot express the distinction. If a
 * route needs a narrower audience, the better answer is usually a narrower permission.
 */
export const ROLE_ONLY_KEY = 'roleOnly';
export const RoleOnly = () => SetMetadata(ROLE_ONLY_KEY, true);

export const PERMISSIONS_KEY = 'permissions';

/**
 * Decorator to require specific permissions on a route.
 * Format: 'RESOURCE:ACTION:SCOPE' (e.g., 'PROJECT:CREATE:ORGANIZATION')
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Same reasoning as RolesGuard: an explicitly public route must not be gated here.
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) return true;

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true; // No permission restriction
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user || !user.roles) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // Build flat permission set from user's roles
    const userPermissions = permissionKeysHeldBy(user);

    const hasPermission = requiredPermissions.every((perm) =>
      userPermissions.has(perm.toUpperCase()),
    );

    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
