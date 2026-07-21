import { ClientEntity } from '../client/client.entity';
export interface RecommendationConfig {
    weights: Record<string, number>;
    defaultRadius: number;
}
export declare class ConfigurationResolver {
    resolveRecommendationConfig(client?: ClientEntity | null, requestOverrides?: Partial<RecommendationConfig>): RecommendationConfig;
}
