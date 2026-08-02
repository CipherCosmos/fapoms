"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INDIAN_STATES = void 0;
exports.calculateHaversineDistance = calculateHaversineDistance;
exports.canonicalState = canonicalState;
exports.INDIAN_STATES = [
    { value: 'Andhra Pradesh', label: 'Andhra Pradesh' }, { value: 'Arunachal Pradesh', label: 'Arunachal Pradesh' },
    { value: 'Assam', label: 'Assam' }, { value: 'Bihar', label: 'Bihar' },
    { value: 'Chhattisgarh', label: 'Chhattisgarh' }, { value: 'Goa', label: 'Goa' },
    { value: 'Gujarat', label: 'Gujarat' }, { value: 'Haryana', label: 'Haryana' },
    { value: 'Himachal Pradesh', label: 'Himachal Pradesh' }, { value: 'Jharkhand', label: 'Jharkhand' },
    { value: 'Karnataka', label: 'Karnataka' }, { value: 'Kerala', label: 'Kerala' },
    { value: 'Madhya Pradesh', label: 'Madhya Pradesh' }, { value: 'Maharashtra', label: 'Maharashtra' },
    { value: 'Manipur', label: 'Manipur' }, { value: 'Meghalaya', label: 'Meghalaya' },
    { value: 'Mizoram', label: 'Mizoram' }, { value: 'Nagaland', label: 'Nagaland' },
    { value: 'Odisha', label: 'Odisha' }, { value: 'Punjab', label: 'Punjab' },
    { value: 'Rajasthan', label: 'Rajasthan' }, { value: 'Sikkim', label: 'Sikkim' },
    { value: 'Tamil Nadu', label: 'Tamil Nadu' }, { value: 'Telangana', label: 'Telangana' },
    { value: 'Tripura', label: 'Tripura' }, { value: 'Uttar Pradesh', label: 'Uttar Pradesh' },
    { value: 'Uttarakhand', label: 'Uttarakhand' }, { value: 'West Bengal', label: 'West Bengal' },
    { value: 'Andaman and Nicobar Islands', label: 'Andaman and Nicobar Islands' },
    { value: 'Chandigarh', label: 'Chandigarh' }, { value: 'Delhi', label: 'Delhi' },
    { value: 'Jammu and Kashmir', label: 'Jammu and Kashmir' }, { value: 'Ladakh', label: 'Ladakh' },
    { value: 'Lakshadweep', label: 'Lakshadweep' }, { value: 'Puducherry', label: 'Puducherry' },
];
/**
 * Calculates the great-circle distance between two points on the Earth's surface
 * using the Haversine formula.
 *
 * @param lat1 Latitude of point 1 in degrees
 * @param lon1 Longitude of point 1 in degrees
 * @param lat2 Latitude of point 2 in degrees
 * @param lon2 Longitude of point 2 in degrees
 * @returns Distance in kilometers
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth's radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}
/**
 * Branch and assayer state names come from different sources — client branch
 * lists and internal rosters — and do not agree: a branch is in `MAHARASHTRA`
 * while an assayer living there is recorded under `Maharashtra` or `maharashtra`,
 * and `ANDRAPRADESH` faces `A.P`. Comparing raw values treats these as different
 * states. Canonicalise for comparison; keep the original for display.
 */
const STATE_ALIASES = {
    AP: 'ANDHRA PRADESH', 'A P': 'ANDHRA PRADESH', ANDRAPRADESH: 'ANDHRA PRADESH',
    ANDHRAPRADESH: 'ANDHRA PRADESH', 'ANDHRA PRADESH': 'ANDHRA PRADESH',
    TS: 'TELANGANA', TELANGANA: 'TELANGANA',
    TN: 'TAMIL NADU', TAMILNADU: 'TAMIL NADU', 'TAMIL NADU': 'TAMIL NADU',
    KL: 'KERALA', KERALA: 'KERALA',
    KA: 'KARNATAKA', KARNATAKA: 'KARNATAKA',
    MH: 'MAHARASHTRA', MAHARASHTRA: 'MAHARASHTRA',
    OD: 'ODISHA', ORISSA: 'ODISHA', ODISHA: 'ODISHA',
    RJ: 'RAJASTHAN', RAJASTHAN: 'RAJASTHAN',
    UP: 'UTTAR PRADESH', UTTARPRADESH: 'UTTAR PRADESH', 'UTTAR PRADESH': 'UTTAR PRADESH',
    PY: 'PUDUCHERRY', PONDICHERRY: 'PUDUCHERRY', PUDUCHERRY: 'PUDUCHERRY',
    DL: 'DELHI', 'NEW DELHI': 'DELHI', DELHI: 'DELHI',
    GJ: 'GUJARAT', GUJARAT: 'GUJARAT', WB: 'WEST BENGAL', 'WEST BENGAL': 'WEST BENGAL',
};
/** Uppercase, strip punctuation, collapse spaces, then resolve known aliases. */
function canonicalState(raw) {
    if (!raw)
        return 'UNKNOWN';
    const k = String(raw).toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    return STATE_ALIASES[k] ?? STATE_ALIASES[k.replace(/\s/g, '')] ?? k;
}
//# sourceMappingURL=utils.js.map