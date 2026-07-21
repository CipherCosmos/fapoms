export interface ClientConfigurationProvider {
    planningPreferences?: {
        weights?: Record<string, any>;
    } | null;
    configuration?: {
        defaultRadius?: number;
    } | null;
}
export interface RecommendationConfig {
    weights: Record<string, number>;
    defaultRadius: number;
}
export declare class ConfigurationResolver {
    resolveRecommendationConfig(client?: ClientConfigurationProvider | null, requestOverrides?: Partial<RecommendationConfig>): RecommendationConfig;
}
