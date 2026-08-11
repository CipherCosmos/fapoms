import { ForbiddenException } from '@nestjs/common';
import { Region } from '@fapoms/shared';
import { assignedRegions, resolveGlobalScope, resolveRegionScope } from './global-scope';

describe('global scope', () => {
  describe('assignedRegions', () => {
    it('treats a missing or empty assignment as unrestricted', () => {
      expect(assignedRegions(null)).toBeNull();
      expect(assignedRegions({})).toBeNull();
      expect(assignedRegions({ regions: null })).toBeNull();
      expect(assignedRegions({ regions: [] })).toBeNull();
    });

    it('keeps only recognised regions', () => {
      expect(assignedRegions({ regions: ['WEST', 'nonsense'] })).toEqual([Region.WEST]);
    });

    // A wholly unrecognised assignment is a data fault. Reading it as "no assignment" would
    // silently promote a restricted operator to seeing every region — fail closed instead.
    it('refuses an assignment it cannot understand at all', () => {
      expect(() => assignedRegions({ regions: ['Maharashtra'] })).toThrow(ForbiddenException);
    });
  });

  describe('resolveRegionScope', () => {
    it('is unrestricted when nothing is requested and nothing is assigned', () => {
      expect(resolveRegionScope(undefined, {})).toBeNull();
      expect(resolveRegionScope('ALL', {})).toBeNull();
    });

    it('falls back to the assignment when no region is requested', () => {
      expect(resolveRegionScope('ALL', { regions: ['WEST', 'SOUTH'] })).toEqual([
        Region.WEST,
        Region.SOUTH,
      ]);
    });

    it('narrows an unassigned account to whatever it asked for', () => {
      expect(resolveRegionScope('SOUTH', {})).toEqual([Region.SOUTH]);
    });

    it('accepts a state name as the requested region', () => {
      expect(resolveRegionScope('Maharashtra', {})).toEqual([Region.WEST]);
    });

    it('narrows within the assignment', () => {
      expect(resolveRegionScope('WEST', { regions: ['WEST', 'SOUTH'] })).toEqual([Region.WEST]);
    });

    // The whole point of server-side enforcement: the query string is not a trust boundary.
    it('refuses a region the account does not hold', () => {
      expect(() => resolveRegionScope('NORTH', { regions: ['WEST'] })).toThrow(ForbiddenException);
    });

    it('refuses an unrecognisable region rather than ignoring it', () => {
      expect(() => resolveRegionScope('Atlantis', {})).toThrow(ForbiddenException);
    });

    // 'ALL' must not widen a restricted account back out.
    it('does not let ALL escape an assignment', () => {
      expect(resolveRegionScope('ALL', { regions: ['WEST'] })).toEqual([Region.WEST]);
    });
  });

  describe('resolveGlobalScope', () => {
    it('reads the convenience filters off the query string', () => {
      const scope = resolveGlobalScope(
        { projectId: 'p1', clientId: 'c1', zoneId: 'z1', state: 'Gujarat', region: 'WEST' },
        {},
      );
      expect(scope).toEqual({
        projectId: 'p1',
        clientId: 'c1',
        zoneId: 'z1',
        state: 'Gujarat',
        regions: [Region.WEST],
      });
    });

    it('treats ALL, blank and non-string values as absent', () => {
      const scope = resolveGlobalScope(
        { projectId: 'ALL', clientId: '   ', zoneId: ['z1'], state: undefined },
        {},
      );
      expect(scope.projectId).toBeUndefined();
      expect(scope.clientId).toBeUndefined();
      expect(scope.zoneId).toBeUndefined();
      expect(scope.state).toBeUndefined();
      expect(scope.regions).toBeNull();
    });
  });
});
