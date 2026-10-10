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
