import { getMetadataArgsStorage } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { decimalNumberTransformer } from './decimal-number.transformer';
import { BranchEntity } from '../../modules/branch/branch.entity';
import { AssayerEntity } from '../../modules/assayer/assayer.entity';
import { OptimizeRouteDto } from '../../modules/geo/geo.controller';

/**
 * W1 (2026-09-24): decimal coordinates arrived as strings, and "Optimize route" posted them to a
 * DTO that says `@IsNumber()`. The coordinate columns now convert at the column.
 */
describe('decimal coordinates are numbers', () => {
  it('converts the driver\'s strings, keeps null, and never produces NaN', () => {
    const from = decimalNumberTransformer.from as (v: unknown) => unknown;
    expect(from('18.5204303')).toBe(18.5204303);
    expect(from(73.85)).toBe(73.85);
    expect(from(null)).toBeNull();
    expect(from(undefined)).toBeNull();
    expect(from('')).toBeNull();
    expect(from('not-a-number')).toBeNull();
  });

  const transformerOf = (target: Function, property: string) =>
    getMetadataArgsStorage().columns.find((c) => c.target === target && c.propertyName === property)?.options.transformer;

  it.each([
    [BranchEntity, 'latitude'], [BranchEntity, 'longitude'],
    [AssayerEntity, 'latitude'], [AssayerEntity, 'longitude'],
    [AssayerEntity, 'liveLatitude'], [AssayerEntity, 'liveLongitude'],
  ])('%p.%s carries the transformer', (target, property) => {
    expect(transformerOf(target as Function, property as string)).toBe(decimalNumberTransformer);
  });

  it('the optimize DTO refuses string coordinates — which is why the columns must convert', () => {
    const body = (lat: unknown) => ({
      origin: { latitude: lat, longitude: 73.8 },
      destinations: [{ id: 'b-1', latitude: 18.6, longitude: 73.9 }],
    });
    const asString = validateSync(plainToInstance(OptimizeRouteDto, body('18.5')) as object);
    const asNumber = validateSync(plainToInstance(OptimizeRouteDto, body(
      (decimalNumberTransformer.from as (v: unknown) => number)('18.5'),
    )) as object);
    expect(asString.length).toBeGreaterThan(0);
    expect(asNumber).toHaveLength(0);
  });
});
