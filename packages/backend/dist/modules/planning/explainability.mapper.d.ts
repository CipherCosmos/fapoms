export interface ExplanationReason {
    type: 'POSITIVE' | 'NEGATIVE';
    message: string;
}
export declare function generateExplanation(breakdown: Record<string, number>, details: {
    displayName: string;
    distanceKm: number | null;
    performanceRating?: number | null;
    experienceYears?: number | null;
    baseFee?: number | null;
}): ExplanationReason[];
