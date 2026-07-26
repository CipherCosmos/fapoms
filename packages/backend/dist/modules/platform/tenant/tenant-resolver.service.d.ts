export interface TenantContext {
    tenantId: string;
}
export declare class TenantContextResolver {
    private currentContext;
    setContext(context: TenantContext): void;
    getContext(): TenantContext | null;
    clear(): void;
}
