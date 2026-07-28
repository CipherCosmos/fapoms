"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateExplanation = generateExplanation;
function generateExplanation(breakdown, details) {
    const reasons = [];
    if (details.distanceKm !== null) {
        if (details.distanceKm <= 15) {
            reasons.push({
                type: 'POSITIVE',
                message: `${details.displayName} is located very close to the branch (${details.distanceKm.toFixed(1)} km away).`,
            });
        }
        else if (details.distanceKm > 100) {
            reasons.push({
                type: 'NEGATIVE',
                message: `${details.displayName} is located far from the branch (${details.distanceKm.toFixed(1)} km away), which may increase travel costs.`,
            });
        }
    }
    if (details.performanceRating !== undefined && details.performanceRating !== null) {
        if (details.performanceRating >= 4.5) {
            reasons.push({
                type: 'POSITIVE',
                message: `High performance rating of ${details.performanceRating} indicates exceptional service quality history.`,
            });
        }
        else if (details.performanceRating < 3.5) {
            reasons.push({
                type: 'NEGATIVE',
                message: `Performance rating is lower than average (${details.performanceRating}).`,
            });
        }
    }
    if (breakdown.workload !== undefined) {
        if (breakdown.workload >= 80) {
            reasons.push({
                type: 'POSITIVE',
                message: `Excellent availability with ample remaining weekly workload capacity.`,
            });
        }
        else if (breakdown.workload < 30) {
            reasons.push({
                type: 'NEGATIVE',
                message: `High active workload; assayer is near weekly capacity limit.`,
            });
        }
    }
    if (breakdown.profitability !== undefined) {
        if (breakdown.profitability > 80) {
            reasons.push({
                type: 'POSITIVE',
                message: `Highly cost-effective selection fits well within client's target budget.`,
            });
        }
        else if (breakdown.profitability < 40) {
            reasons.push({
                type: 'NEGATIVE',
                message: `Higher commercial cost profile exceeds client's typical target budget parameters.`,
            });
        }
    }
    return reasons;
}
//# sourceMappingURL=explainability.mapper.js.map