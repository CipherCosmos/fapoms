import { Injectable } from '@nestjs/common';

export interface TenantContext {
  tenantId: string;
}

@Injectable()
export class TenantContextResolver {
  private currentContext: TenantContext | null = null;

  setContext(context: TenantContext): void {
    this.currentContext = context;
  }

  getContext(): TenantContext | null {
    return this.currentContext;
  }

  clear(): void {
    this.currentContext = null;
  }
}
