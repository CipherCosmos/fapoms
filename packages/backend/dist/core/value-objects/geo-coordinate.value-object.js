"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeoCoordinate = void 0;
class GeoCoordinate {
    latitude;
    longitude;
    constructor(latitude, longitude) {
        this.latitude = latitude;
        this.longitude = longitude;
        if (latitude < -90 || latitude > 90)
            throw new Error('Invalid latitude');
        if (longitude < -180 || longitude > 180)
            throw new Error('Invalid longitude');
    }
}
exports.GeoCoordinate = GeoCoordinate;
//# sourceMappingURL=geo-coordinate.value-object.js.map