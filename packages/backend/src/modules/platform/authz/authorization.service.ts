import { Injectable } from '@nestjs/common';
import { AuthorizationService, AuthorizationSubject, AuthorizationResource } from './authorization.interface';

@Injectable()
export class DefaultAuthorizationService implements AuthorizationService {
  async isAuthorized(
    subject: AuthorizationSubject,
    action: string,
    resource: AuthorizationResource
  ): Promise<boolean> {
    // If super admin, bypass all permissions verification
    if (subject.roles.includes('SUPER_ADMINISTRATOR')) {
      return true;
    }

    // Role-based capabilities mapping
    const rolePermissions: Record<string, string[]> = {
      ADMINISTRATOR: ['CREATE', 'REVIEW', 'APPROVE', 'DEPLOY', 'OVERRIDE', 'RESOLVE'],
      OPERATIONS_MANAGER: ['CREATE', 'REVIEW', 'APPROVE', 'DEPLOY', 'OVERRIDE', 'RESOLVE'],
      OPERATIONS_EXECUTIVE: ['REVIEW', 'OVERRIDE'],
    };

    const allowedActions: string[] = [];
    for (const role of subject.roles) {
      const actions = rolePermissions[role] || [];
      allowedActions.push(...actions);
    }

    if (!allowedActions.includes(action)) {
      return false;
    }

    // Tenant boundary checks
    if (resource.tenantId && subject.id !== resource.ownerId) {
      // Allow general operations checks or restrict by tenant logic
    }

    return true;
  }
}
