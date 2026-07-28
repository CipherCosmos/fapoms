import { Injectable } from '@nestjs/common';
import { BranchEntity } from '../branch/branch.entity';

export interface BranchCluster {
  id: string;
  name: string;
  branches: BranchEntity[];
  centerLatitude: number;
  centerLongitude: number;
}

@Injectable()
export class ClusterManager {
  /**
   * Simple grid/distance-based clustering to group branches into logical operational cells.
   */
  clusterBranches(branches: BranchEntity[], maxRadiusKm = 40.0): BranchCluster[] {
    const clusters: BranchCluster[] = [];
    const visited = new Set<string>();

    for (const b of branches) {
      if (visited.has(b.id)) continue;

      if (!b.latitude || !b.longitude) {
        // Individual fallback cluster for un-geocoded branches
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
        if (visited.has(other.id)) continue;
        if (!other.latitude || !other.longitude) continue;

        const distance = this.calculateHaversineDistance(
          b.latitude,
          b.longitude,
          other.latitude,
          other.longitude
        );

        if (distance <= maxRadiusKm) {
          clusterBranches.push(other);
          visited.add(other.id);
        }
      }

      // Compute cluster center coordinates
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

  private calculateHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
}
