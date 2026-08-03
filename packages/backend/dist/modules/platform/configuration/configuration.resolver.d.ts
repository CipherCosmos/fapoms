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
    static knownWeightKeys(): string[];
    static assertWeightsCoverAllCalculators(calculatorNames: string[]): string[];
    resolveRecommendationConfig(client?: ClientConfigurationProvider | null, requestOverrides?: Partial<RecommendationConfig>): RecommendationConfig;
}
