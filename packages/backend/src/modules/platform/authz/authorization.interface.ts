export interface AuthorizationSubject {
  id: string;
  roles: string[];
}

export interface AuthorizationResource {
  id: string;
  type: string;
  ownerId?: string;
  tenantId?: string;
}

export interface AuthorizationService {
  isAuthorized(
    subject: AuthorizationSubject,
    action: string,
    resource: AuthorizationResource
  ): Promise<boolean>;
}
