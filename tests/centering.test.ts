import { describe, expect, it } from 'vitest';
import { centerPolygon, polygonCentroid } from '../src/house/centering.ts';
import { demoFootprint } from '../src/house/houseMesh.ts';

describe('polygon centroid', () => {
  it('returns the vertex average of a right triangle', () => {
    const centroid = polygonCentroid([
      { east: 0, north: 0 },
      { east: 6, north: 0 },
      { east: 0, north: 6 },
    ]);
    expect(centroid.east).toBeCloseTo(2, 6);
    expect(centroid.north).toBeCloseTo(2, 6);
  });

  it('centers the offset demonstration footprint on the origin', () => {
    const raw = demoFootprint();
    const before = polygonCentroid(raw);
    expect(before.east).toBeCloseTo(4, 6);
    expect(before.north).toBeCloseTo(-3, 6);

    const centered = centerPolygon(raw);
    const after = polygonCentroid(centered.points);
    expect(after.east).toBeCloseTo(0, 6);
    expect(after.north).toBeCloseTo(0, 6);
  });
});
