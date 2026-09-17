/**
 * THE MATHS BEHIND THE SCANNER, WITH NO BROWSER IN IT.
 *
 * Everything here takes plain arrays and returns plain arrays: no canvas, no video, no React. That
 * is deliberate and it is the only reason any of it is tested — jsdom has no canvas, so anything
 * written inside the component would have been shipped on the strength of it looking right on one
 * phone. The component does exactly two things this file cannot: get pixels out of a camera, and
 * put pixels into a canvas.
 *
 * What it does, in the order the scanner does it:
 *
 *   1. `detectPageQuad`  — find the four corners of the page in the frame.
 *   2. `warpQuad`        — lift that quadrilateral out and square it up (perspective correction).
 *   3. `enhance`         — make it read like a scan rather than a photograph of a desk.
 *
 * None of it needs to be perfect, because the person holding the phone gets to drag the corners
 * before anything is uploaded. It needs to be *right often enough to save them the work*, and
 * honest when it has not found anything — hence a nullable return rather than a confident guess at
 * the frame's own edges.
 */

export interface Point { x: number; y: number }

/** Corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type ScanFinish = 'photo' | 'document' | 'ink';

// ── 1. Finding the page ─────────────────────────────────────────────────────

/** Luminance, the same weighting every image library uses (ITU-R BT.601). */
export function toGrey(rgba: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return out;
}

/** A 3×3 box blur, run before the gradient so paper texture and JPEG noise do not become edges. */
function blur(grey: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(grey.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += grey[yy * width + xx];
          n += 1;
        }
      }
      out[y * width + x] = sum / n;
    }
  }
  return out;
}

/** Sobel gradient magnitude — how sharply the image changes at each pixel. */
function gradient(grey: Uint8ClampedArray, width: number, height: number): Float32Array {
  const mag = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = grey[i - width - 1]; const tc = grey[i - width]; const tr = grey[i - width + 1];
      const ml = grey[i - 1]; const mr = grey[i + 1];
      const bl = grey[i + width - 1]; const bc = grey[i + width]; const br = grey[i + width + 1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

interface Line { theta: number; rho: number; votes: number }

/**
 * A Hough transform, which is the standard way to find straight lines in a noisy picture.
 *
 * Every edge pixel votes for all the lines that could pass through it, written as an angle and a
 * distance from the origin; a real line in the image collects votes from all of its pixels and
 * stands out as a peak. Angles at 1° and distances in 2px buckets, on a frame downscaled to a few
 * hundred pixels — coarse, but the corners get dragged by hand afterwards, and precision here
 * would cost time the shutter cannot spare.
 */
function houghLines(
  mag: Float32Array, width: number, height: number, threshold: number,
): Line[] {
  const RHO_STEP = 2;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoBuckets = Math.ceil((2 * diagonal) / RHO_STEP) + 1;
  const acc = new Float32Array(180 * rhoBuckets);
  const cos: number[] = [];
  const sin: number[] = [];
  for (let t = 0; t < 180; t += 1) {
    cos[t] = Math.cos((t * Math.PI) / 180);
    sin[t] = Math.sin((t * Math.PI) / 180);
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mag[y * width + x] < threshold) continue;
      for (let t = 0; t < 180; t += 1) {
        const rho = x * cos[t] + y * sin[t];
        const bucket = Math.round((rho + diagonal) / RHO_STEP);
        acc[t * rhoBuckets + bucket] += 1;
      }
    }
  }

  // Peaks only: a line that is beaten by a near neighbour is the same line one bucket over.
  const found: Line[] = [];
  const minVotes = Math.max(12, Math.round(Math.min(width, height) * 0.25));
  for (let t = 0; t < 180; t += 1) {
    for (let b = 1; b < rhoBuckets - 1; b += 1) {
      const votes = acc[t * rhoBuckets + b];
      if (votes < minVotes) continue;
      let best = true;
      for (let dt = -2; dt <= 2 && best; dt += 1) {
        const tt = (t + dt + 180) % 180;
        for (let db = -3; db <= 3; db += 1) {
          const bb = b + db;
          if (bb < 0 || bb >= rhoBuckets || (dt === 0 && db === 0)) continue;
          if (acc[tt * rhoBuckets + bb] > votes) { best = false; break; }
        }
      }
      if (best) found.push({ theta: (t * Math.PI) / 180, rho: b * RHO_STEP - diagonal, votes });
    }
  }
  return found.sort((a, b) => b.votes - a.votes);
}

/** Where two lines cross, or null when they are parallel enough not to have a usable crossing. */
function intersect(a: Line, b: Line): Point | null {
  const det = Math.cos(a.theta) * Math.sin(b.theta) - Math.sin(a.theta) * Math.cos(b.theta);
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (a.rho * Math.sin(b.theta) - b.rho * Math.sin(a.theta)) / det,
    y: (b.rho * Math.cos(a.theta) - a.rho * Math.cos(b.theta)) / det,
  };
}

/** The smaller angle between two line directions, 0…90°. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return (d > Math.PI / 2 ? Math.PI - d : d) * (180 / Math.PI);
}

/**
 * Corners sorted into reading order, whichever order they arrived in.
 *
 * By angle around the centre rather than by "smallest sum is top-left", which is the version that
 * is everywhere on the internet and which mislabels corners as soon as the page is rotated more
 * than about 30°: a tilted page's top-right corner can have a smaller x+y than its top-left.
 */
export function orderQuad(points: Point[]): Quad {
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const byAngle = [...points].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );
  // atan2 starts at "due left of centre, going down"; the first corner past the top-left diagonal
  // is the top-left one, so rotate the ring until it leads.
  const start = byAngle.findIndex((p) => p.x <= cx && p.y <= cy);
  const ring = start <= 0 ? byAngle : [...byAngle.slice(start), ...byAngle.slice(0, start)];
  return ring as Quad;
}

function polygonArea(quad: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function isConvex(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * The page in the frame, or null when there is no convincing one.
 *
 * Null is a real answer and the commonest one in a bad light: the component then offers the whole
 * frame with the corners already draggable, which is a worse starting point but an honest one. A
 * detector that always returns something would put a confident green outline around a desk.
 */
export function detectPageQuad(
  grey: Uint8ClampedArray, width: number, height: number,
): Quad | null {
  if (width < 32 || height < 32) return null;
  const mag = gradient(blur(grey, width, height), width, height);

  // The threshold is a percentile, not a constant: what counts as a strong edge in a dim room is
  // nothing at all in daylight, and a fixed number finds either everything or nothing.
  const sorted = Float32Array.from(mag).sort();
  const threshold = Math.max(24, sorted[Math.floor(sorted.length * 0.9)]);

  const lines = houghLines(mag, width, height, threshold).slice(0, 40);
  if (lines.length < 4) return null;

  const best = lines[0];
  const minGap = Math.min(width, height) * 0.25;
  // Two families: lines running with the strongest one, and lines running across it. A page gives
  // two of each; anything within 25° counts as the same family, which tolerates a hand-held tilt.
  const along = lines.filter((l) => angleBetween(l.theta, best.theta) <= 25);
  const across = lines.filter((l) => angleBetween(l.theta, best.theta) >= 65);

  const farthestPair = (family: Line[]): [Line, Line] | null => {
    for (let i = 0; i < family.length; i += 1) {
      for (let j = i + 1; j < family.length; j += 1) {
        if (Math.abs(family[i].rho - family[j].rho) >= minGap) return [family[i], family[j]];
      }
    }
    return null;
  };

  // Strongest-first, so the first pair far enough apart is the most-voted-for pair that could be
  // two opposite edges of a page rather than the two sides of one thick line.
  const sides = farthestPair(along);
  const ends = farthestPair(across);
  if (!sides || !ends) return null;

  const corners: Point[] = [];
  for (const s of sides) {
    for (const e of ends) {
      const p = intersect(s, e);
      if (!p) return null;
      corners.push(p);
    }
  }

  const quad = orderQuad(corners);
  const margin = Math.max(width, height) * 0.06;
  const inFrame = quad.every(
    (p) => p.x >= -margin && p.y >= -margin && p.x <= width + margin && p.y <= height + margin,
  );
  // A page that fills a tenth of the frame is a stamp on a desk, not the document being scanned,
  // and a non-convex "quad" is four lines that never formed one.
  if (!inFrame || !isConvex(quad) || polygonArea(quad) < width * height * 0.12) return null;
  return quad;
}

// ── 2. Squaring it up ───────────────────────────────────────────────────────

/**
 * How big the corrected page should be, from the quadrilateral's own edges.
 *
 * Opposite edges of a photographed page differ — the near edge is longer than the far one — so
 * each dimension takes the longer of its pair: shrinking to the short edge would squash text that
 * the long edge captured fine. Capped, because the output is a JPEG somebody uploads over mobile
 * data, not an archival master.
 */
export function quadOutputSize(quad: Quad, maxEdge = 2000): { width: number; height: number } {
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const [tl, tr, br, bl] = quad;
  const width = Math.max(dist(tl, tr), dist(bl, br));
  const height = Math.max(dist(tl, bl), dist(tr, br));
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** How wide the quad is against how tall, after it has been squared up. */
export function quadAspect(quad: Quad): number {
  const size = quadOutputSize(quad, Number.POSITIVE_INFINITY);
  return size.height === 0 ? 0 : size.width / size.height;
}

/**
 * The same four corners, read starting one place round.
 *
 * Which corner is "top-left" is what decides which edge becomes the width, so turning the labels
 * turns the finished scan a quarter of the way round without touching a pixel. It is how a card
 * held upright in somebody's hand comes out landscape, the way a card is read.
 */
export function rotateQuad(quad: Quad): Quad {
  return [quad[3], quad[0], quad[1], quad[2]];
}

/**
 * The 3×3 homography taking the output rectangle's corners onto the quad's.
 *
 * Eight unknowns (the ninth is fixed at 1 by scale), so four point pairs give exactly eight
 * equations — solved by plain Gaussian elimination with partial pivoting. This is the *inverse*
 * direction on purpose: warping asks "which source pixel does this output pixel come from", and
 * asking it the other way round leaves holes wherever the source is stretched.
 */
export function solveHomography(from: Quad, to: Quad): number[] | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 8; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null; // degenerate: three corners in a line
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];

    for (let r = 0; r < 8; r += 1) {
      if (r === col) continue;
      const factor = a[r][col] / a[col][col];
      if (factor === 0) continue;
      for (let c = col; c < 8; c += 1) a[r][c] -= factor * a[col][c];
      b[r] -= factor * b[col];
    }
  }

  const h = b.map((value, i) => value / a[i][i]);
  return [...h, 1];
}

/** Bilinear sample, so a corrected page does not come out with staircase edges on its text. */
function sample(
  rgba: Uint8ClampedArray, width: number, height: number, x: number, y: number, out: Uint8ClampedArray, at: number,
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let c = 0; c < 4; c += 1) {
    let total = 0;
    for (let dy = 0; dy < 2; dy += 1) {
      for (let dx = 0; dx < 2; dx += 1) {
        const sx = Math.min(width - 1, Math.max(0, x0 + dx));
        const sy = Math.min(height - 1, Math.max(0, y0 + dy));
        const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        total += rgba[(sy * width + sx) * 4 + c] * weight;
      }
    }
    out[at + c] = total;
  }
}

/** The page lifted out of the photograph and laid flat. */
export function warpQuad(
  rgba: Uint8ClampedArray, width: number, height: number,
  quad: Quad, outWidth: number, outHeight: number,
): Uint8ClampedArray | null {
  const rect: Quad = [
    { x: 0, y: 0 }, { x: outWidth, y: 0 }, { x: outWidth, y: outHeight }, { x: 0, y: outHeight },
  ];
  const h = solveHomography(rect, quad);
  if (!h) return null;

  const out = new Uint8ClampedArray(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    for (let x = 0; x < outWidth; x += 1) {
      const w = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / w;
      const sy = (h[3] * x + h[4] * y + h[5]) / w;
      sample(rgba, width, height, sx, sy, out, (y * outWidth + x) * 4);
    }
  }
  return out;
}

// ── 3. Making it read like a scan ───────────────────────────────────────────

/** Sums of every pixel above and left of each point, so a box average costs four lookups. */
function integralImage(grey: Uint8ClampedArray, width: number, height: number): Float64Array {
  const sum = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += grey[y * width + x];
      sum[(y + 1) * (width + 1) + (x + 1)] = sum[y * (width + 1) + (x + 1)] + row;
    }
  }
  return sum;
}

/**
 * Three finishes, because the papers are not one kind of thing.
 *
 * `photo` leaves the colour alone — a photograph, a bank passbook, anything where the colour is
 * part of what is being verified, and the default for exactly that reason. `document` is grey with
 * its contrast stretched to the ink and the paper it actually has, which is what a flatbed does.
 * `ink` thresholds against the local average rather than one number for the whole page, so a
 * shadow across the corner stops turning into a black corner — the failure everybody knows from
 * photographing a page under their own hand.
 */
export function enhance(
  rgba: Uint8ClampedArray, width: number, height: number, finish: ScanFinish,
): Uint8ClampedArray {
  if (finish === 'photo') return rgba;

  const grey = toGrey(rgba, width, height);
  const out = new Uint8ClampedArray(rgba.length);

  if (finish === 'document') {
    // Clipped at the 5th and 95th percentile: a true min/max would be set by one dark speck and
    // one glare highlight, and nothing in between would move at all.
    const sorted = Uint8ClampedArray.from(grey).sort();
    const low = sorted[Math.floor(sorted.length * 0.05)];
    const high = sorted[Math.floor(sorted.length * 0.95)];
    const span = Math.max(1, high - low);
    for (let i = 0; i < grey.length; i += 1) {
      const v = Math.max(0, Math.min(255, ((grey[i] - low) / span) * 255));
      out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
    }
    return out;
  }

  const sum = integralImage(grey, width, height);
  const radius = Math.max(8, Math.round(Math.min(width, height) / 24));
  const stride = width + 1;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const local = (
        sum[(y1 + 1) * stride + (x1 + 1)] - sum[y0 * stride + (x1 + 1)]
        - sum[(y1 + 1) * stride + x0] + sum[y0 * stride + x0]
      ) / area;
      // 8% below the local average, so an even expanse of paper stays paper instead of dissolving
      // into noise around its own mean.
      const v = grey[y * width + x] < local * 0.92 ? 0 : 255;
      const i = (y * width + x) * 4;
      out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
    }
  }
  return out;
}
