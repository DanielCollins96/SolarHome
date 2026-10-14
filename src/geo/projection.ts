import type { PlanPoint } from '../house/centering.ts';

/** Mean Earth radius used for the local tangent-plane approximation. */
export const EARTH_RADIUS_M = 6_378_137;

export interface LngLat {
  longitude: number;
  latitude: number;
}

/**
 * Local east-north metres on the tangent plane at `origin`.
 * Accurate for a single building; it is not a national grid projection.
 * Scene axes use the same east and north, with Z = −north (south).
 */
export function projectToLocal(point: LngLat, origin: LngLat): PlanPoint {
  const lat0 = (origin.latitude * Math.PI) / 180;
  const east = ((point.longitude - origin.longitude) * Math.PI * EARTH_RADIUS_M * Math.cos(lat0)) / 180;
  const north = ((point.latitude - origin.latitude) * Math.PI * EARTH_RADIUS_M) / 180;
  return { east, north };
}

export function localToLngLat(point: PlanPoint, origin: LngLat): LngLat {
  const lat0 = (origin.latitude * Math.PI) / 180;
  const longitude = origin.longitude + (point.east / (EARTH_RADIUS_M * Math.cos(lat0))) * (180 / Math.PI);
  const latitude = origin.latitude + (point.north / EARTH_RADIUS_M) * (180 / Math.PI);
  return { longitude, latitude };
}

export function projectRing(ring: readonly LngLat[], origin: LngLat): PlanPoint[] {
  return ring.map((point) => projectToLocal(point, origin));
}

export function unprojectRing(ring: readonly PlanPoint[], origin: LngLat): LngLat[] {
  return ring.map((point) => localToLngLat(point, origin));
}

interface LngLatBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

/** About a centimetre of slack, so a point on an edge still counts as inside, as `pointInRing` does. */
const BOUNDS_SLACK_DEG = 1e-7;
const boundsCache = new WeakMap<readonly LngLat[], LngLatBounds>();

/** The ring's longitude and latitude extent, worked out once per ring. */
function ringBounds(ring: readonly LngLat[]): LngLatBounds {
  let bounds = boundsCache.get(ring);
  if (bounds === undefined) {
    bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    for (const point of ring) {
      bounds.west = Math.min(bounds.west, point.longitude);
      bounds.east = Math.max(bounds.east, point.longitude);
      bounds.south = Math.min(bounds.south, point.latitude);
      bounds.north = Math.max(bounds.north, point.latitude);
    }
    boundsCache.set(ring, bounds);
  }
  return bounds;
}

/**
 * False when the point is plainly outside the ring's extent. A selection of hundreds of outlines,
 * like the Palace of Westminster, would otherwise project every corner for every point it tests.
 */
export function ringMayContain(ring: readonly LngLat[], point: LngLat): boolean {
  const bounds = ringBounds(ring);
  return (
    point.longitude >= bounds.west - BOUNDS_SLACK_DEG &&
    point.longitude <= bounds.east + BOUNDS_SLACK_DEG &&
    point.latitude >= bounds.south - BOUNDS_SLACK_DEG &&
    point.latitude <= bounds.north + BOUNDS_SLACK_DEG
  );
}

/** False when the two rings' extents do not meet. */
export function ringsMayOverlap(a: readonly LngLat[], b: readonly LngLat[]): boolean {
  const one = ringBounds(a);
  const two = ringBounds(b);
  return one.west <= two.east + BOUNDS_SLACK_DEG && two.west <= one.east + BOUNDS_SLACK_DEG && one.south <= two.north + BOUNDS_SLACK_DEG && two.south <= one.north + BOUNDS_SLACK_DEG;
}
