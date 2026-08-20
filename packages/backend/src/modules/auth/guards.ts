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
     * Scoped to principals that actually carry the flag — the staff `UserEntity` does; the
     * assayer mobile principal does not, so the field app's own forced-change flow is unchanged
     * and nobody in the field is locked out by this. The exempt routes (change the password,
     * read your own profile, log out) stay open so the forcing cannot trap the user.
     */
    if (this.reflector) {
      const exempt = this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_EXEMPT_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!exempt) {
        const user = context.switchToHttp().getRequest()?.user;
        if (user?.mustChangePassword === true) {
          throw new ForbiddenException(
            'You must change your password before you can continue. Please set a new password.',
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
    const hasRole = requiredRoles.some((role) => userRoles.includes(role));

    if (!hasRole) {
      throw new ForbiddenException('Insufficient role permissions');
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Permission-Based Access Control Guard
// ---------------------------------------------------------------------------

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
    const userPermissions = new Set<string>();
    for (const role of user.roles) {
      for (const perm of role.permissions || []) {
        userPermissions.add(`${perm.resource}:${perm.action}:${perm.scope}`);
        // PLATFORM scope implies all lower scopes
        if (perm.scope === 'PLATFORM') {
          userPermissions.add(`${perm.resource}:${perm.action}:ORGANIZATION`);
          userPermissions.add(`${perm.resource}:${perm.action}:CLIENT`);
          userPermissions.add(`${perm.resource}:${perm.action}:STATE`);
          userPermissions.add(`${perm.resource}:${perm.action}:REGION`);
          userPermissions.add(`${perm.resource}:${perm.action}:DEPARTMENT`);
          userPermissions.add(`${perm.resource}:${perm.action}:TEAM`);
          userPermissions.add(`${perm.resource}:${perm.action}:SELF`);
        }
      }
    }

    const hasPermission = requiredPermissions.every((perm) =>
      userPermissions.has(perm.toUpperCase()),
    );

    if (!hasPermission) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
