"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cluster_manager_1 = require("./cluster.manager");
describe('ClusterManager', () => {
    let manager;
    beforeEach(() => {
        manager = new cluster_manager_1.ClusterManager();
    });
    it('should group close branches into a single cluster', () => {
        const branch1 = { id: 'b-1', name: 'Branch 1', latitude: 19.076, longitude: 72.8777, city: 'Mumbai' };
        const branch2 = { id: 'b-2', name: 'Branch 2', latitude: 19.082, longitude: 72.882, city: 'Mumbai' };
        const branchFar = { id: 'b-3', name: 'Branch Far', latitude: 28.6139, longitude: 77.209, city: 'Delhi' };
        const clusters = manager.clusterBranches([branch1, branch2, branchFar]);
        expect(clusters.length).toBe(2);
        const miamiCluster = clusters.find((c) => c.branches.some((b) => b.id === 'b-1'));
        expect(miamiCluster.branches.length).toBe(2);
    });
});
//# sourceMappingURL=cluster.manager.spec.js.map