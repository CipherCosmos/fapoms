"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClusterManager = void 0;
const common_1 = require("@nestjs/common");
let ClusterManager = class ClusterManager {
    clusterBranches(branches, maxRadiusKm = 40.0) {
        const clusters = [];
        const visited = new Set();
        for (const b of branches) {
            if (visited.has(b.id))
                continue;
            if (!b.latitude || !b.longitude) {
                clusters.push({
                    id: `cluster-unlocated-${b.id}`,
                    name: `Unlocated Branch Group (${b.name})`,
                    branches: [b],
                    centerLatitude: 0,
                    centerLongitude: 0,
                });
                visited.add(b.id);
                continue;
            }
            const clusterBranches = [b];
            visited.add(b.id);
            for (const other of branches) {
                if (visited.has(other.id))
                    continue;
                if (!other.latitude || !other.longitude)
                    continue;
                const distance = this.calculateHaversineDistance(b.latitude, b.longitude, other.latitude, other.longitude);
                if (distance <= maxRadiusKm) {
                    clusterBranches.push(other);
                    visited.add(other.id);
                }
            }
            const totalCount = clusterBranches.length;
            const sumLat = clusterBranches.reduce((acc, curr) => acc + (curr.latitude || 0), 0);
            const sumLng = clusterBranches.reduce((acc, curr) => acc + (curr.longitude || 0), 0);
            clusters.push({
                id: `cluster-${b.id}`,
                name: `Cluster - ${b.city || b.district || 'Region'} (${totalCount} branches)`,
                branches: clusterBranches,
                centerLatitude: parseFloat((sumLat / totalCount).toFixed(4)),
                centerLongitude: parseFloat((sumLng / totalCount).toFixed(4)),
            });
        }
        return clusters;
    }
    calculateHaversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371;
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
};
exports.ClusterManager = ClusterManager;
exports.ClusterManager = ClusterManager = __decorate([
    (0, common_1.Injectable)()
], ClusterManager);
//# sourceMappingURL=cluster.manager.js.map