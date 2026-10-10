import type { PlanPoint } from './centering.ts';
import { distance, openRing, reverseRing, selfIntersects, signedArea } from './planGeometry.ts';

const SHORT_EDGE_M = 0.3;
const RIGHT_ANGLE_TOLERANCE_DEG = 5;

export interface CleanedFootprint {
  points: PlanPoint[];
  issues: string[];
}

/**
 * Drop tiny edges, square near-right corners, and force a counter-clockwise ring.
 * Problems that would destroy the outline are reported and left in place.
 */
export function cleanFootprint(points: readonly PlanPoint[]): CleanedFootprint {
  const issues: string[] = [];
  let ring = openRing(points);
  if (ring.length < 3) {
    return { points: ring, issues: ['The outline needs at least 3 corners.'] };
  }

  ring = dropShortEdges(ring, issues);
  ring = snapRightAngles(ring, issues);
  if (signedArea(ring) < 0) ring = reverseRing(ring);
  if (selfIntersects(ring)) {
    issues.push('The outline crosses itself and was not untangled.');
  }
  return { points: ring, issues };
}

function dropShortEdges(points: PlanPoint[], issues: string[]): PlanPoint[] {
  const ring = points.slice();
  let guard = ring.length;
  while (guard-- > 0) {
    const index = shortestEdgeEnd(ring);
    if (index < 0) break;
    if (ring.length <= 3) {
      issues.push('An edge shorter than 0.3 m was kept so the outline would not disappear.');
      break;
    }
    ring.splice(index, 1);
  }
  return ring;
}

function shortestEdgeEnd(points: readonly PlanPoint[]): number {
  for (let i = 0; i < points.length; i++) {
    if (distance(points[i], points[(i + 1) % points.length]) < SHORT_EDGE_M) {
      return (i + 1) % points.length;
    }
  }
  return -1;
}

function snapRightAngles(points: readonly PlanPoint[], issues: string[]): PlanPoint[] {
  const next = points.map((point) => ({ ...point }));
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const previous = points[(i - 1 + count) % count];
    const current = points[i];
    const following = points[(i + 1) % count];
    if (previous === undefined || current === undefined || following === undefined) continue;
    const degrees = cornerDegrees(previous, current, following);
    if (Math.abs(degrees - 90) > RIGHT_ANGLE_TOLERANCE_DEG) continue;
    const snapped = rightAnglePoint(previous, current, following);
    if (snapped === null) {
      issues.push('A near-right corner could not be squared.');
      continue;
    }
    const candidate = next.slice();
    candidate[i] = snapped;
    if (selfIntersects(candidate) || Math.abs(signedArea(candidate)) < 1e-4) {
      issues.push('A near-right corner was left alone because squaring it broke the outline.');
      continue;
    }
    next[i] = snapped;
  }
  return next;
}

function cornerDegrees(previous: PlanPoint, current: PlanPoint, following: PlanPoint): number {
  const inEast = previous.east - current.east;
  const inNorth = previous.north - current.north;
  const outEast = following.east - current.east;
  const outNorth = following.north - current.north;
  const dot = inEast * outEast + inNorth * outNorth;
  const cross = inEast * outNorth - inNorth * outEast;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

/** Closest point that makes a right angle, by Thales' theorem (circle with diameter previous–following). */
function rightAnglePoint(previous: PlanPoint, current: PlanPoint, following: PlanPoint): PlanPoint | null {
  const midEast = (previous.east + following.east) / 2;
  const midNorth = (previous.north + following.north) / 2;
  const radius = Math.hypot(following.east - previous.east, following.north - previous.north) / 2;
  const fromMidEast = current.east - midEast;
  const fromMidNorth = current.north - midNorth;
  const fromMid = Math.hypot(fromMidEast, fromMidNorth);
  if (radius < 1e-6 || fromMid < 1e-6) return null;
  return {
    east: midEast + (fromMidEast / fromMid) * radius,
    north: midNorth + (fromMidNorth / fromMid) * radius,
  };
}
