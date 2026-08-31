import { BadRequestException } from '@nestjs/common';
import { ClientService } from './client.service';
import { ConfigurationResolver } from '../platform/configuration/configuration.resolver';

/**
 * The client module's first tests, on the function that most deserves them.
 *
 * `validateTunables` is the only thing between an operator and a client configuration that
 * silently empties every candidate list or zeroes every ranking score. The module is ~1,800
 * lines and had no specs at all; these cover the two failure modes that actually happened.
 *
 * The service is exercised directly — `validateTunables` is pure and touches no repository —
 * so the test needs none of the module's wiring.
 */
describe('client tunables', () => {
  // Reach the private validator the way the create/update paths do, without the DI graph.
  const service = Object.create(ClientService.prototype) as any;
  const validate = (dto: any) => service.validateTunables(dto);

  describe('ranking weights', () => {
    const known = ConfigurationResolver.knownWeightKeys();

    it('accepts a weight the engine actually reads', () => {
      expect(() => validate({ planningPreferences: { weights: { [known[0]]: 0.2 } } })).not.toThrow();
    });

    /**
     * The bug this prevents: `"0.14"` passed the range check (which coerces to test it) and was
     * then stored verbatim in jsonb. `totalWeight += "0.14"` is string concatenation, so the
     * weighted mean became NaN and EVERY candidate for that client scored exactly 0.00 — an
     * empty-looking ranking with no error anywhere. The engine now defends at read time too;
     * this stops it being written in the first place.
     */
    it('stores a numeric weight sent as a string as a NUMBER', () => {
      const dto: any = { planningPreferences: { weights: { [known[0]]: '0.14' } } };
      validate(dto);
      expect(dto.planningPreferences.weights[known[0]]).toBe(0.14);
      expect(typeof dto.planningPreferences.weights[known[0]]).toBe('number');
    });

    it('refuses a dimension no calculator reads, naming the ones that exist', () => {
      // A typo is otherwise accepted, stored, and does nothing for ever.
      expect(() => validate({ planningPreferences: { weights: { distence: 0.9 } } }))
        .toThrow(BadRequestException);
      try {
        validate({ planningPreferences: { weights: { distence: 0.9 } } });
      } catch (e: any) {
        expect(e.message).toContain('is not a ranking dimension');
        expect(e.message).toContain(known[0]);
      }
    });

    it('keeps a weight inside 0–1 — a weight is a share', () => {
      expect(() => validate({ planningPreferences: { weights: { [known[0]]: 50 } } })).toThrow(BadRequestException);
      expect(() => validate({ planningPreferences: { weights: { [known[0]]: -1 } } })).toThrow(BadRequestException);
      expect(() => validate({ planningPreferences: { weights: { [known[0]]: 'heavy' } } })).toThrow(BadRequestException);
    });
  });

  describe('distance bounds', () => {
    it('refuses a maximum below the minimum — it excludes every candidate, silently', () => {
      expect(() => validate({ planningPreferences: { minDistanceKm: 80, maxDistanceKm: 20 } }))
        .toThrow(BadRequestException);
    });

    it('accepts a sane pair, and either bound on its own', () => {
      expect(() => validate({ planningPreferences: { minDistanceKm: 5, maxDistanceKm: 300 } })).not.toThrow();
      expect(() => validate({ planningPreferences: { minDistanceKm: 5 } })).not.toThrow();
      expect(() => validate({ planningPreferences: { maxDistanceKm: 300 } })).not.toThrow();
    });

    it('keeps distances inside the range the country makes possible', () => {
      expect(() => validate({ planningPreferences: { maxDistanceKm: 99_999 } })).toThrow(BadRequestException);
    });
  });

  describe('SLA rules', () => {
    it('bounds the numbers an operator types', () => {
      expect(() => validate({ configuration: { slaRules: { maxResponseTimeHours: 0 } } })).toThrow(BadRequestException);
      expect(() => validate({ configuration: { slaRules: { penaltyRate: 150 } } })).toThrow(BadRequestException);
      expect(() => validate({ configuration: { slaRules: { schedulingWindowDays: 400 } } })).toThrow(BadRequestException);
    });

    it('accepts a realistic rule set', () => {
      expect(() => validate({
        configuration: { slaRules: { maxAuditsPerMonth: 500, schedulingWindowDays: 30, maxResponseTimeHours: 24, penaltyRate: 5 } },
      })).not.toThrow();
    });
  });

  it('ignores a dto with nothing to validate', () => {
    expect(() => validate({})).not.toThrow();
    expect(() => validate({ planningPreferences: {} })).not.toThrow();
  });
});
