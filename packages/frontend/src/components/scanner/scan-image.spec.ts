import {
  toGrey, detectPageQuad, orderQuad, quadOutputSize, solveHomography, warpQuad, enhance,
  quadAspect, rotateQuad,
  type Point, type Quad,
} from './scan-image';

/**
 * These build photographs rather than loading them: a page of a given colour, at a given skew, on
 * a desk of another colour, drawn pixel by pixel. That is what makes the detector testable at all
 * — the true corners are known exactly, so "found the page" can be measured in pixels instead of
 * eyeballed, and a change that makes detection worse fails here instead of on somebody's phone in
 * a branch.
 */

interface Canvas { rgba: Uint8ClampedArray; width: number; height: number }

const inside = (quad: Quad, p: Point): boolean => {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
};

/** A page (bright) on a desk (dark), with a little noise so nothing depends on flat colour. */
function photograph(width: number, height: number, page: Quad, opts?: {
  paper?: number; desk?: number; noise?: number;
}): Canvas {
  const paper = opts?.paper ?? 230;
  const desk = opts?.desk ?? 60;
  const noise = opts?.noise ?? 6;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const jitter = () => {
    // A fixed generator, not Math.random: a detector that passes only on lucky noise is not passing.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ((seed / 2147483648) - 0.5) * 2 * noise;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = (inside(page, { x: x + 0.5, y: y + 0.5 }) ? paper : desk) + jitter();
      const i = (y * width + x) * 4;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return { rgba, width, height };
}

const greyOf = (c: Canvas) => toGrey(c.rgba, c.width, c.height);

/** How far the found corners sit from the true ones, at their worst. */
function worstCornerError(found: Quad, truth: Quad): number {
  return Math.max(...truth.map((t, i) => Math.hypot(found[i].x - t.x, found[i].y - t.y)));
}

describe('finding the page in a photograph', () => {
  it('finds a page held square to the camera', () => {
    const truth: Quad = [{ x: 40, y: 30 }, { x: 280, y: 30 }, { x: 280, y: 330 }, { x: 40, y: 330 }];
    const shot = photograph(320, 360, truth);

    const found = detectPageQuad(greyOf(shot), shot.width, shot.height);
    expect(found).not.toBeNull();
    expect(worstCornerError(found as Quad, truth)).toBeLessThan(6);
  });

  /** The normal case: nobody holds a phone parallel to the desk. */
  it('finds a page photographed at an angle', () => {
    const truth: Quad = [{ x: 58, y: 44 }, { x: 268, y: 26 }, { x: 292, y: 322 }, { x: 34, y: 300 }];
    const shot = photograph(320, 360, truth);

    const found = detectPageQuad(greyOf(shot), shot.width, shot.height);
    expect(found).not.toBeNull();
    expect(worstCornerError(found as Quad, truth)).toBeLessThan(10);
  });

  it('finds a dark card on a light desk, not only paper on wood', () => {
    const truth: Quad = [{ x: 44, y: 60 }, { x: 276, y: 48 }, { x: 284, y: 250 }, { x: 36, y: 262 }];
    const shot = photograph(320, 320, truth, { paper: 55, desk: 225 });

    const found = detectPageQuad(greyOf(shot), shot.width, shot.height);
    expect(found).not.toBeNull();
    expect(worstCornerError(found as Quad, truth)).toBeLessThan(10);
  });

  /**
   * Answering "nothing here" is a feature, not a shortfall. The component then hands over the
   * whole frame with draggable corners, which is honest; a detector that always answers would draw
   * a confident outline around a desk and square up the wrong rectangle.
   */
  it('answers nothing for a frame with no page in it', () => {
    const empty = photograph(320, 320, [
      { x: -50, y: -50 }, { x: -40, y: -50 }, { x: -40, y: -40 }, { x: -50, y: -40 },
    ], { noise: 14 });

    expect(detectPageQuad(greyOf(empty), empty.width, empty.height)).toBeNull();
  });

  it('answers nothing for a stamp-sized shape that is not the document', () => {
    const stamp: Quad = [{ x: 140, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 195 }, { x: 140, y: 195 }];
    const shot = photograph(320, 320, stamp);

    expect(detectPageQuad(greyOf(shot), shot.width, shot.height)).toBeNull();
  });

  it('has nothing to say about a frame too small to hold a page', () => {
    expect(detectPageQuad(new Uint8ClampedArray(16 * 16), 16, 16)).toBeNull();
  });
});

describe('putting corners in reading order', () => {
  it('labels them top-left, top-right, bottom-right, bottom-left whatever order they arrive in', () => {
    const corners: Point[] = [
      { x: 90, y: 90 }, { x: 10, y: 10 }, { x: 10, y: 90 }, { x: 90, y: 10 },
    ];
    expect(orderQuad(corners)).toEqual([
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ]);
  });

  /**
   * The version everyone copies picks top-left as the smallest x+y, which mislabels every corner
   * of a page tilted much past 30° — here the true top-left (20,60) has a LARGER sum than the top-
   * right (80,20), so that rule would rotate the whole page a quarter turn on upload.
   */
  it('survives a tilt that the "smallest x plus y" rule gets wrong', () => {
    const tilted: Point[] = [
      { x: 20, y: 60 }, { x: 80, y: 20 }, { x: 120, y: 80 }, { x: 60, y: 120 },
    ];
    expect(orderQuad(tilted)[0]).toEqual({ x: 20, y: 60 });
    expect(orderQuad(tilted)[2]).toEqual({ x: 120, y: 80 });
  });
});

describe('squaring the page up', () => {
  const skewed: Quad = [{ x: 20, y: 10 }, { x: 180, y: 30 }, { x: 170, y: 230 }, { x: 10, y: 200 }];

  it('sizes the output from the longer of each pair of opposite edges', () => {
    const size = quadOutputSize(skewed);
    // The near edge is longer than the far one; taking the short edge would squash the text the
    // long edge caught perfectly well.
    expect(size.width).toBeGreaterThanOrEqual(161);
    expect(size.height).toBeGreaterThanOrEqual(200);
  });

  it('caps the output so a scan stays uploadable over mobile data', () => {
    const huge: Quad = [{ x: 0, y: 0 }, { x: 6000, y: 0 }, { x: 6000, y: 9000 }, { x: 0, y: 9000 }];
    const size = quadOutputSize(huge, 2000);
    expect(Math.max(size.width, size.height)).toBe(2000);
    expect(size.width / size.height).toBeCloseTo(6000 / 9000, 2);
  });

  it('maps the output rectangle onto the quad exactly at the corners', () => {
    const rect: Quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 }, { x: 0, y: 200 }];
    const h = solveHomography(rect, skewed) as number[];
    expect(h).not.toBeNull();

    rect.forEach((corner, i) => {
      const w = h[6] * corner.x + h[7] * corner.y + h[8];
      const x = (h[0] * corner.x + h[1] * corner.y + h[2]) / w;
      const y = (h[3] * corner.x + h[4] * corner.y + h[5]) / w;
      expect(x).toBeCloseTo(skewed[i].x, 6);
      expect(y).toBeCloseTo(skewed[i].y, 6);
    });
  });

  it('refuses a degenerate quad rather than returning nonsense', () => {
    const flat: Quad = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 25, y: 0 }];
    expect(solveHomography(flat, flat)).toBeNull();
  });

  /** The whole point: what was a skewed page in the frame comes out filling the output square-on. */
  it('lifts the page out and fills the output with it', () => {
    const shot = photograph(240, 260, skewed, { noise: 0 });
    const flat = warpQuad(shot.rgba, shot.width, shot.height, skewed, 120, 150) as Uint8ClampedArray;
    expect(flat).not.toBeNull();

    const at = (x: number, y: number) => flat[(y * 120 + x) * 4];
    // Every corner of the output is paper now — in the original photograph three of these four
    // points were desk.
    expect(at(4, 4)).toBeGreaterThan(200);
    expect(at(115, 4)).toBeGreaterThan(200);
    expect(at(115, 145)).toBeGreaterThan(200);
    expect(at(4, 145)).toBeGreaterThan(200);
    expect(at(60, 75)).toBeGreaterThan(200);
  });
});

describe('turning a capture to match the document', () => {
  const upright: Quad = [{ x: 0, y: 0 }, { x: 54, y: 0 }, { x: 54, y: 86 }, { x: 0, y: 86 }];

  it('measures how wide a capture is against how tall', () => {
    expect(quadAspect(upright)).toBeCloseTo(54 / 86, 3);
  });

  /** A card held upright in somebody's hand is a card; the labels turn, the pixels do not. */
  it('reads the corners one place round, which lays the scan on its side', () => {
    const turned = rotateQuad(upright);
    expect(quadAspect(turned)).toBeCloseTo(86 / 54, 3);
    expect(turned[0]).toEqual(upright[3]);
  });

  it('comes back to where it started after four turns', () => {
    expect(rotateQuad(rotateQuad(rotateQuad(rotateQuad(upright))))).toEqual(upright);
  });
});

describe('making it read like a scan', () => {
  /** A washed-out page: ink at 120, paper at 180, nothing using the ends of the range. */
  const washedOut = (): Canvas => {
    const width = 60;
    const height = 60;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = x % 12 < 3 ? 120 : 180;
        const i = (y * width + x) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }
    return { rgba, width, height };
  };

  it('leaves a photograph alone, because its colour is the point', () => {
    const c = washedOut();
    expect(enhance(c.rgba, c.width, c.height, 'photo')).toBe(c.rgba);
  });

  it('stretches a flat page onto the full range, the way a flatbed does', () => {
    const c = washedOut();
    const out = enhance(c.rgba, c.width, c.height, 'document');
    const values = [];
    for (let i = 0; i < out.length; i += 4) values.push(out[i]);
    expect(Math.min(...values)).toBeLessThan(20);
    expect(Math.max(...values)).toBeGreaterThan(235);
  });

  /**
   * The failure everybody knows: photographing a page under your own hand puts a shadow across one
   * side, and a single threshold for the whole page turns that side solid black. Thresholding
   * against the LOCAL average keeps the ink and drops the shadow.
   */
  it('keeps text readable through a shadow across the page', () => {
    const width = 120;
    const height = 60;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const shade = x > width / 2 ? 0.45 : 1;       // a hand's shadow over the right half
        const isInk = x % 10 < 3;
        const v = (isInk ? 90 : 220) * shade;
        const i = (y * width + x) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
      }
    }

    const out = enhance(rgba, width, height, 'ink');
    const valueAt = (x: number, y: number) => out[(y * width + x) * 4];
    // Paper is white and ink is black on BOTH sides of the shadow line.
    expect(valueAt(5, 30)).toBe(255);
    expect(valueAt(1, 30)).toBe(0);
    expect(valueAt(95, 30)).toBe(255);
    expect(valueAt(91, 30)).toBe(0);
  });
});
