import { localToLngLat, projectToLocal, type LngLat } from '../geo/projection.ts';
import type { PlanPoint } from '../house/centering.ts';
import { closestPointOnSegment, distance, distanceToSegment } from '../house/planGeometry.ts';

const OSM_SNAP_M = 1.5;
const EDGE_SPLIT_M = 1.2;
const VERTEX_GUARD_M = 0.6;
const RIGHT_ANGLE_DEG = 5;

export interface TraceSnap {
  point: LngLat;
  kind: 'vertex' | 'edge' | 'right-angle' | 'none';
}

/** Snap to an OpenStreetMap corner or edge, otherwise to a right angle with the previous wall. */
export function snapTracePoint(
  point: LngLat,
  origin: LngLat,
  previous: LngLat | undefined,
  beforePrevious: LngLat | undefined,
  osmRing: readonly LngLat[],
): TraceSnap {
  const local = projectToLocal(point, origin);
  const osm = osmRing.map((vertex) => projectToLocal(vertex, origin));
  const vertex = nearestVertex(local, osm, OSM_SNAP_M);
  if (vertex !== null) return { point: localToLngLat(vertex, origin), kind: 'vertex' };
  const edge = nearestOnEdges(local, osm, OSM_SNAP_M);
  if (edge !== null) return { point: localToLngLat(edge, origin), kind: 'edge' };
  if (previous !== undefined && beforePrevious !== undefined) {
    const squared = rightAngleSnap(local, projectToLocal(previous, origin), projectToLocal(beforePrevious, origin));
    if (squared !== null) return { point: localToLngLat(squared, origin), kind: 'right-angle' };
  }
  return { point, kind: 'none' };
}

/** Insert a corner when the click lands on an edge but not on an existing corner. */
export function splitEdge(
  point: LngLat,
  ring: readonly LngLat[],
  origin: LngLat,
): { index: number; point: LngLat } | null {
  if (ring.length < 2) return null;
  const local = projectToLocal(point, origin);
  const projected = ring.map((vertex) => projectToLocal(vertex, origin));
  let best = EDGE_SPLIT_M;
  let found: { index: number; point: PlanPoint } | null = null;
  for (let i = 0; i < projected.length; i++) {
    const start = projected[i];
    const end = projected[(i + 1) % projected.length];
    if (start === undefined || end === undefined) continue;
    if (distance(local, start) < VERTEX_GUARD_M || distance(local, end) < VERTEX_GUARD_M) continue;
    const gap = distanceToSegment(local, start, end);
    if (gap < best) {
      best = gap;
      found = { index: i, point: closestPointOnSegment(local, start, end) };
    }
  }
  if (found === null) return null;
  return { index: found.index, point: localToLngLat(found.point, origin) };
}

function nearestVertex(point: PlanPoint, ring: PlanPoint[], maxMeters: number): PlanPoint | null {
  let best = maxMeters;
  let found: PlanPoint | null = null;
  for (const vertex of ring) {
    const gap = distance(point, vertex);
    if (gap < best) {
      best = gap;
      found = vertex;
    }
  }
  return found;
}

function nearestOnEdges(point: PlanPoint, ring: PlanPoint[], maxMeters: number): PlanPoint | null {
  let best = maxMeters;
  let found: PlanPoint | null = null;
  for (let i = 0; i < ring.length; i++) {
    const start = ring[i];
    const end = ring[(i + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    const closest = closestPointOnSegment(point, start, end);
    const gap = distance(point, closest);
    if (gap < best && distance(closest, start) > VERTEX_GUARD_M && distance(closest, end) > VERTEX_GUARD_M) {
      best = gap;
      found = closest;
    }
  }
  return found;
}

function rightAngleSnap(point: PlanPoint, previous: PlanPoint, beforePrevious: PlanPoint): PlanPoint | null {
  const runEast = previous.east - beforePrevious.east;
  const runNorth = previous.north - beforePrevious.north;
  const run = Math.hypot(runEast, runNorth);
  if (run < 1e-6) return null;
  const toEast = point.east - previous.east;
  const toNorth = point.north - previous.north;
  const length = Math.hypot(toEast, toNorth);
  if (length < 0.05) return null;
  const candidates = [
    { east: -runNorth / run, north: runEast / run },
    { east: runNorth / run, north: -runEast / run },
  ];
  let bestAngle = (RIGHT_ANGLE_DEG * Math.PI) / 180;
  let best: PlanPoint | null = null;
  for (const candidate of candidates) {
    const angle = Math.acos(
      Math.min(1, Math.max(-1, (toEast * candidate.east + toNorth * candidate.north) / length)),
    );
    if (angle < bestAngle) {
      bestAngle = angle;
      best = { east: previous.east + candidate.east * length, north: previous.north + candidate.north * length };
    }
  }
  return best;
}

