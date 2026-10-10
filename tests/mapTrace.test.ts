import { describe, expect, it } from 'vitest';
import { localToLngLat } from '../src/geo/projection.ts';
import { snapTracePoint, splitEdge } from '../src/trace/mapTrace.ts';

const origin = { latitude: 39.75, longitude: -105.22 };

function at(east: number, north: number) {
  return localToLngLat({ east, north }, origin);
}

const osm = [at(0, 0), at(12, 0), at(12, 8), at(0, 8)];

describe('map tracing', () => {
  it('snaps a nearby click to an OpenStreetMap corner', () => {
    const snapped = snapTracePoint(at(0.4, 0.2), origin, undefined, undefined, osm);
    expect(snapped.kind).toBe('vertex');
    expect(snapped.point.latitude).toBeCloseTo(osm[0]?.latitude ?? 0, 8);
    expect(snapped.point.longitude).toBeCloseTo(osm[0]?.longitude ?? 0, 8);
  });

  it('splits the edge under a click', () => {
    const ring = [at(0, 0), at(10, 0), at(10, 6), at(0, 6)];
    const split = splitEdge(at(5, 0.2), ring, origin);
    expect(split?.index).toBe(0);
    expect(split?.point.longitude).toBeCloseTo(at(5, 0).longitude, 7);
  });
});
