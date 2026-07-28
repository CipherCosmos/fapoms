import { AuthorizationService, AuthorizationSubject, AuthorizationResource } from './authorization.interface';
export declare class DefaultAuthorizationService implements AuthorizationService {
    isAuthorized(subject: AuthorizationSubject, action: string, resource: AuthorizationResource): Promise<boolean>;
}
