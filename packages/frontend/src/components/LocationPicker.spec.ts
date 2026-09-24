import { isPlausibleIndianCoord } from './LocationPicker';

/**
 * A pin dropped or dragged outside India is refused with a sentence rather than saved as somebody's
 * home — the same box the phone app checks (`isPlausibleIndianCoord` in mobile's `MapPicker`), so
 * the two surfaces refuse the same pins.
 */
describe('a map pin must be in India', () => {
  it.each([
    ['Pune', 18.52, 73.86],
    ['Kanyakumari', 8.08, 77.54],
    ['Leh', 34.15, 77.58],
    ['Port Blair', 11.62, 92.73],
  ])('accepts %s', (_place, lat, lng) => {
    expect(isPlausibleIndianCoord(lat, lng)).toBe(true);
  });

  it.each([
    ['London', 51.5, -0.12],
    ['Dubai', 25.2, 55.27],
    ['Null Island (0, 0)', 0, 0],
    ['nothing at all', null, null],
    ['not a number', Number.NaN, 77],
  ])('refuses %s', (_place, lat, lng) => {
    expect(isPlausibleIndianCoord(lat as number | null, lng as number | null)).toBe(false);
  });
});
