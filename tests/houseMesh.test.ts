import { Box3, BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { DEMO_GABLE_HOUSE, buildGableHouse } from '../src/house/houseMesh.ts';

describe('gable house mesh', () => {
  const house = buildGableHouse(DEMO_GABLE_HOUSE);
  const bounds = new Box3();
  const wallBox = house.walls.boundingBox;
  const roofBox = house.roof.boundingBox;
  if (!wallBox || !roofBox) throw new Error('House geometry has no bounds.');
  bounds.union(wallBox);
  bounds.union(roofBox);

  it('sits on the ground with its footprint centroid at the origin', () => {
    expect(bounds.min.y).toBeCloseTo(0, 6);
    expect(bounds.max.y).toBeCloseTo(house.ridgeHeight, 5);
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(0, 5);
    expect((bounds.min.z + bounds.max.z) / 2).toBeCloseTo(0, 5);
    expect(bounds.max.x - bounds.min.x).toBeCloseTo(12, 5);
    expect(bounds.max.z - bounds.min.z).toBeCloseTo(8, 5);
  });

  it('points the south roof normal up and south', () => {
    const pitch = (DEMO_GABLE_HOUSE.pitchDegrees * Math.PI) / 180;
    expect(hasNormal(house.roof, 0, Math.cos(pitch), Math.sin(pitch))).toBe(true);
  });

  it('points the south wall normal south', () => {
    expect(hasNormal(house.walls, 0, 0, 1)).toBe(true);
  });
});

function hasNormal(geometry: { getAttribute(name: string): unknown }, x: number, y: number, z: number): boolean {
  const normal = geometry.getAttribute('normal');
  if (!(normal instanceof BufferAttribute)) throw new Error('Expected a buffer normal.');
  for (let index = 0; index < normal.count; index += 1) {
    if (
      Math.abs(normal.getX(index) - x) < 1e-4 &&
      Math.abs(normal.getY(index) - y) < 1e-4 &&
      Math.abs(normal.getZ(index) - z) < 1e-4
    ) {
      return true;
    }
  }
  return false;
}
