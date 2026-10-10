import type { PlanPoint } from './centering.ts';

/** Signed area in square meters. Positive when the ring is counter-clockwise. */
export function signedArea(points: readonly PlanPoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    twice += current.east * next.north - next.east * current.north;
  }
  return twice / 2;
}

export function ringLength(points: readonly PlanPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance(points[i], points[(i + 1) % points.length]);
  }
  return total;
}

export function distance(a: PlanPoint | undefined, b: PlanPoint | undefined): number {
  if (a === undefined || b === undefined) return 0;
  return Math.hypot(b.east - a.east, b.north - a.north);
}

/** Drop a repeated closing vertex. The stored ring is open. */
export function openRing(points: readonly PlanPoint[]): PlanPoint[] {
  if (points.length >= 2 && distance(points[0], points[points.length - 1]) < 1e-6) {
    return points.slice(0, -1).map(copyPoint);
  }
  return points.map(copyPoint);
}

export function copyPoint(point: PlanPoint): PlanPoint {
  return { east: point.east, north: point.north };
}

export function reverseRing(points: readonly PlanPoint[]): PlanPoint[] {
  return points.map(copyPoint).reverse();
}

/** Even-odd test. Points on the boundary count as inside. */
export function pointInRing(point: PlanPoint, ring: readonly PlanPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (distanceToSegment(point, a, b) < 1e-6) return true;
    const crosses = a.north > point.north !== b.north > point.north;
    if (!crosses) continue;
    const east = ((b.east - a.east) * (point.north - a.north)) / (b.north - a.north) + a.east;
    if (point.east < east) inside = !inside;
  }
  return inside;
}

export function segmentsIntersect(a: PlanPoint, b: PlanPoint, c: PlanPoint, d: PlanPoint): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 === 0 && onSegment(a, c, b)) return false;
  if (o2 === 0 && onSegment(a, d, b)) return false;
  if (o3 === 0 && onSegment(c, a, d)) return false;
  if (o4 === 0 && onSegment(c, b, d)) return false;
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function selfIntersects(points: readonly PlanPoint[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (c === undefined || d === undefined) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

export function distanceToSegment(point: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  return distance(point, closestPointOnSegment(point, a, b));
}

export function closestPointOnSegment(point: PlanPoint, a: PlanPoint, b: PlanPoint): PlanPoint {
  const abe = b.east - a.east;
  const abn = b.north - a.north;
  const lengthSq = abe * abe + abn * abn;
  if (lengthSq < 1e-12) return copyPoint(a);
  const t = Math.min(1, Math.max(0, ((point.east - a.east) * abe + (point.north - a.north) * abn) / lengthSq));
  return { east: a.east + t * abe, north: a.north + t * abn };
}

/**
 * Parallel-curve offset. Positive distance moves counter-clockwise rings outward.
 * Returns null when a corner mitre collapses or the result crosses itself.
 */
export function offsetPolygon(points: readonly PlanPoint[], distance: number): PlanPoint[] | null {
  if (points.length < 3) return null;
  if (Math.abs(distance) < 1e-9) return points.map(copyPoint);

  const lines: { point: PlanPoint; dirEast: number; dirNorth: number }[] = [];
  for (let i = 0; i < points.length; i++) {
    const start = points[i];
    const end = points[(i + 1) % points.length];
    if (start === undefined || end === undefined) return null;
    const edgeEast = end.east - start.east;
    const edgeNorth = end.north - start.north;
    const length = Math.hypot(edgeEast, edgeNorth);
    if (length < 1e-8) return null;
    const outwardEast = edgeNorth / length;
    const outwardNorth = -edgeEast / length;
    lines.push({
      point: {
        east: start.east + outwardEast * distance,
        north: start.north + outwardNorth * distance,
      },
      dirEast: edgeEast,
      dirNorth: edgeNorth,
    });
  }

  const shifted: PlanPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const previous = lines[(i - 1 + points.length) % points.length];
    const current = lines[i];
    if (previous === undefined || current === undefined) return null;
    const hit = intersectLines(previous, current);
    if (hit === null) return null;
    const source = points[i];
    if (source === undefined) return null;
    if (Math.hypot(hit.east - source.east, hit.north - source.north) > Math.abs(distance) * 8) return null;
    shifted.push(hit);
  }

  if (selfIntersects(shifted)) return null;
  if (signedArea(points) > 0 && signedArea(shifted) <= 0) return null;
  return shifted;
}

export function largestInset(points: readonly PlanPoint[]): { distance: number; ring: PlanPoint[] } | null {
  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  for (const point of points) {
    minEast = Math.min(minEast, point.east);
    maxEast = Math.max(maxEast, point.east);
    minNorth = Math.min(minNorth, point.north);
    maxNorth = Math.max(maxNorth, point.north);
  }
  let lo = 0;
  let hi = Math.min(maxEast - minEast, maxNorth - minNorth) / 2;
  let best: { distance: number; ring: PlanPoint[] } | null = null;
  for (let step = 0; step < 20; step++) {
    const mid = (lo + hi) / 2;
    const ring = offsetPolygon(points, -mid);
    if (ring !== null && Math.abs(signedArea(ring)) > 0.05) {
      best = { distance: mid, ring };
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

function intersectLines(
  a: { point: PlanPoint; dirEast: number; dirNorth: number },
  b: { point: PlanPoint; dirEast: number; dirNorth: number },
): PlanPoint | null {
  const det = a.dirEast * b.dirNorth - a.dirNorth * b.dirEast;
  if (Math.abs(det) < 1e-8) {
    return { east: b.point.east, north: b.point.north };
  }
  const deltaEast = b.point.east - a.point.east;
  const deltaNorth = b.point.north - a.point.north;
  const t = (deltaEast * b.dirNorth - deltaNorth * b.dirEast) / det;
  return { east: a.point.east + t * a.dirEast, north: a.point.north + t * a.dirNorth };
}

function orient(a: PlanPoint, b: PlanPoint, c: PlanPoint): number {
  const value = (b.east - a.east) * (c.north - a.north) - (b.north - a.north) * (c.east - a.east);
  if (Math.abs(value) < 1e-9) return 0;
  return Math.sign(value);
}

function onSegment(a: PlanPoint, point: PlanPoint, b: PlanPoint): boolean {
  return (
    point.east <= Math.max(a.east, b.east) + 1e-9 &&
    point.east >= Math.min(a.east, b.east) - 1e-9 &&
    point.north <= Math.max(a.north, b.north) + 1e-9 &&
    point.north >= Math.min(a.north, b.north) - 1e-9
  );
}
