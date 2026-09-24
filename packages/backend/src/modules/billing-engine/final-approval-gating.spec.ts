import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { SystemRole, BILLING_FINAL_APPROVE_PERMISSION } from '@fapoms/shared';
import { RolesGuard, PermissionsGuard, PERMISSIONS_KEY, ROLES_KEY, ALLOW_PERMISSION_FALLBACK_KEY } from '../auth/guards';
import { ROLE_PERMISSIONS } from '../auth/role-permissions';
import { BillingEngineController } from './billing-engine.controller';

/**
 * WHO MAY GIVE THE FINAL APPROVAL (owner, 2026-09-24).
 *
 * The HOD is whoever holds `BILLING:FINAL_APPROVE:ORGANIZATION`: Admin by default (and Developer,
 * who is built from the same business grants and implies Admin), and any role built in Users &
 * Roles that is given it. The office — OPERATIONS, which holds `BILLING:APPROVE` — must NOT be able
 * to give its own approval a second time. Driven through the REAL guards over the REAL controller
 * metadata, so removing a decorator from a route fails here (the mutation check).
 */
describe("the HOD's routes: who may give the final approval", () => {
  const reflector = new Reflector();
  const proto = BillingEngineController.prototype as any;

  /** Every handler on the controller whose path starts `final-approval`. */
  const finalRoutes = Object.getOwnPropertyNames(proto).filter((name) => {
    const handler = proto[name];
    if (typeof handler !== 'function' || name === 'constructor') return false;
    const path: string | undefined = Reflect.getMetadata(PATH_METADATA, handler);
    return typeof path === 'string' && path.startsWith('final-approval');
  });

  const ctx = (user: any, handlerName: string): ExecutionContext => ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => proto[handlerName],
    getClass: () => BillingEngineController,
  }) as any;

  /** A principal shaped the way `validateJwtPayload` builds one, from the grant table or a list. */
  const principal = (roleName: string, keys: string[]) => ({
    id: `u-${roleName}`,
    roles: [{
      name: roleName,
      permissions: keys.map((k) => {
        const [resource, action, scope] = k.split(':');
        return { resource, action, scope };
      }),
    }],
  });

  const passes = (user: any, handlerName: string): boolean => {
    try {
      return new RolesGuard(reflector).canActivate(ctx(user, handlerName)) === true
        && new PermissionsGuard(reflector).canActivate(ctx(user, handlerName)) === true;
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  };

  it('finds the routes — the queue, the bulk approve, and approve/reject for each kind', () => {
    expect(finalRoutes.sort()).toEqual([
      'finalApprovalQueue', 'finalApproveBill', 'finalApproveInvoice', 'finalApproveMany', 'finalApprovePayout',
      'finalRejectBill', 'finalRejectInvoice', 'finalRejectPayout',
    ]);
  });

  it.each([
    'finalApprovalQueue', 'finalApproveBill', 'finalApproveInvoice', 'finalApproveMany', 'finalApprovePayout',
    'finalRejectBill', 'finalRejectInvoice', 'finalRejectPayout',
  ])('%s requires billing:final_approve, names Admin, and admits a custom role that holds it', (name) => {
    const handler = proto[name];
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual(['billing:final_approve:organization']);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([SystemRole.ADMIN]);
    expect(Reflect.getMetadata(ALLOW_PERMISSION_FALLBACK_KEY, handler)).toBe(true);
  });

  describe.each(['finalApprovalQueue', 'finalApproveMany', 'finalApprovePayout', 'finalRejectBill', 'finalApproveInvoice'])('%s', (name) => {
    it('admits Admin, by the grant table', () => {
      expect(passes(principal(SystemRole.ADMIN, ROLE_PERMISSIONS[SystemRole.ADMIN]), name)).toBe(true);
    });

    it('admits Developer — it implies Admin and is built from the same business grants', () => {
      expect(passes(principal(SystemRole.DEVELOPER, ROLE_PERMISSIONS[SystemRole.DEVELOPER]), name)).toBe(true);
    });

    it('admits an "HOD" role built in Users & Roles with the final-approval permission', () => {
      expect(passes(principal('HOD', [BILLING_FINAL_APPROVE_PERMISSION, 'BILLING:VIEW:PLATFORM']), name)).toBe(true);
    });

    it('refuses the office (OPERATIONS), which approves but must not give the final approval', () => {
      expect(passes(principal(SystemRole.OPERATIONS, ROLE_PERMISSIONS[SystemRole.OPERATIONS]), name)).toBe(false);
    });

    it('refuses a custom role holding only the office approval — even widened to PLATFORM', () => {
      expect(passes(principal('BILLING_DESK', ['BILLING:APPROVE:ORGANIZATION', 'BILLING:APPROVE:PLATFORM', 'BILLING:VIEW:PLATFORM']), name)).toBe(false);
    });

    it('refuses the auditor', () => {
      expect(passes(principal(SystemRole.AUDITOR, ROLE_PERMISSIONS[SystemRole.AUDITOR]), name)).toBe(false);
    });
  });

  it('the grant table: Admin and Developer hold it; the office does not', () => {
    expect(ROLE_PERMISSIONS[SystemRole.ADMIN]).toContain(BILLING_FINAL_APPROVE_PERMISSION);
    expect(ROLE_PERMISSIONS[SystemRole.DEVELOPER]).toContain(BILLING_FINAL_APPROVE_PERMISSION);
    for (const role of [SystemRole.OPERATIONS, SystemRole.DESK, SystemRole.DESK_OPERATOR, SystemRole.AUDITOR, SystemRole.CLIENT_USER]) {
      expect({ role, holds: ROLE_PERMISSIONS[role].includes(BILLING_FINAL_APPROVE_PERMISSION) }).toEqual({ role, holds: false });
    }
  });

  it('the office sends a client invoice up and marks it sent with its own edit permission, not the HOD one', () => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.requestInvoiceFinalApproval)).toEqual(['billing:edit:organization']);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.sendInvoice)).toEqual(['billing:edit:organization']);
  });
});
