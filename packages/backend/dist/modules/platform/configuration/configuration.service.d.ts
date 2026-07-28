import { ConfigurationManagerInterface, ConfigurationPolicy } from './configuration-manager.interface';
export declare class DefaultConfigurationService implements ConfigurationManagerInterface {
    private readonly defaultPolicy;
    private tenantOverrides;
    resolveConfig(tenantId: string): Promise<ConfigurationPolicy>;
    overrideConfig(tenantId: string, overrides: Partial<ConfigurationPolicy>, userId: string): Promise<void>;
}
