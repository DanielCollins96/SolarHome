import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { assembleHouse, assembleTrace } from '../src/house/assemble.ts';
import { cleanFootprint } from '../src/house/footprintClean.ts';
import { estimateEaveHeight, parseLengthMeters } from '../src/house/heightEstimate.ts';
import { buildHouseGeometries } from '../src/house/houseMesh.ts';
import {
  exportHouseJson,
  houseFootprintArea,
  importHouseJson,
  type HouseModel,
  type RoofType,
} from '../src/house/houseModel.ts';
import { signedArea } from '../src/house/planGeometry.ts';
import { estimateRoof } from '../src/house/roofEstimate.ts';
import { localToLngLat, projectToLocal, unprojectRing } from '../src/geo/projection.ts';

const rectangle = [
  { east: -6, north: -4 },
  { east: 6, north: -4 },
  { east: 6, north: 4 },
  { east: -6, north: 4 },
];

describe('local projection', () => {
  it('round-trips a point a few metres from the origin', () => {
    const origin = { latitude: 39.742476, longitude: -105.1786 };
    const local = { east: 12.5, north: -3.25 };
    const back = projectToLocal(localToLngLat(local, origin), origin);
    expect(back.east).toBeCloseTo(local.east, 6);
    expect(back.north).toBeCloseTo(local.north, 6);
  });
});

describe('footprint cleanup', () => {
  it('drops an edge shorter than 0.3 m', () => {
    const cleaned = cleanFootprint([
      { east: 0, north: 0 },
      { east: 10, north: 0 },
      { east: 10.1, north: 0 },
      { east: 10.1, north: 8 },
      { east: 0, north: 8 },
    ]);
    expect(cleaned.points).toHaveLength(4);
    expect(signedArea(cleaned.points)).toBeGreaterThan(0);
  });

  it('squares a corner within 5° of a right angle', () => {
    const raw = [
      { east: 0, north: 0 },
      { east: 10, north: 0 },
      { east: 10.2, north: 10 },
      { east: 0, north: 10 },
    ];
    const cleaned = cleanFootprint(raw);
    const corner = cleaned.points[1];
    expect(corner).toBeDefined();
    if (corner === undefined) return;
    expect(corner.east).not.toBeCloseTo(10, 4);
    expect(cornerAngle(raw[0], corner, raw[2])).toBeCloseTo(90, 4);
  });

  it('forces a clockwise ring to counter-clockwise', () => {
    const cleaned = cleanFootprint([...rectangle].reverse());
    expect(signedArea(cleaned.points)).toBeGreaterThan(0);
  });

  it('reports a self-crossing outline without dropping it', () => {
    const cleaned = cleanFootprint([
      { east: 0, north: 0 },
      { east: 4, north: 4 },
      { east: 0, north: 4 },
      { east: 4, north: 0 },
    ]);
    expect(cleaned.points).toHaveLength(4);
    expect(cleaned.issues.some((issue) => issue.includes('crosses itself'))).toBe(true);
  });
});

describe('height and roof tags', () => {
  it('prefers a typed height over every other source', () => {
    const estimate = estimateEaveHeight({
      userMeters: 4,
      lidarMeters: 9,
      osmHeight: '20',
      osmLevels: '3',
      shadowMeters: 7,
    });
    expect(estimate.eaveHeightM).toBe(4);
    expect(estimate.provenance.source).toBe('user');
  });

  it('uses levels times 3 m when there is no height tag', () => {
    const estimate = estimateEaveHeight({ osmLevels: '2' });
    expect(estimate.eaveHeightM).toBe(6);
    expect(estimate.provenance.confidence).toBeLessThan(0.7);
  });

  it('falls back to 6 m when nothing is known', () => {
    const estimate = estimateEaveHeight({});
    expect(estimate.eaveHeightM).toBe(6);
    expect(estimate.provenance.source).toBe('default');
  });

  it('parses feet', () => {
    expect(parseLengthMeters('10 ft')).toBeCloseTo(3.048, 5);
  });

  it('maps roof shapes and treats an unknown shape as a 25° gable', () => {
    expect(estimateRoof({ 'roof:shape': 'skillion', 'roof:direction': 'S' }, rectangle).roof.type).toBe('shed');
    expect(estimateRoof({ 'roof:shape': 'hipped' }, rectangle).roof.type).toBe('hip');
    const unknown = estimateRoof({ 'roof:shape': 'dome' }, rectangle);
    expect(unknown.roof).toMatchObject({ type: 'gable', pitchDeg: 25 });
    expect(unknown.issues[0]).toContain('dome');
  });

  it('turns a downhill roof direction into a ridge 90° away', () => {
    const roof = estimateRoof({ 'roof:shape': 'gabled', 'roof:direction': '180' }, rectangle).roof;
    expect(roof.directionDeg).toBe(270);
  });
});

describe('house model', () => {
  it('round-trips through JSON', () => {
    const model = rectangleModel('gable', 30, 90);
    const imported = importHouseJson(exportHouseJson(model));
    expect(imported).toEqual(model);
  });

  it('rejects a file that is not a house model', () => {
    expect(() => importHouseJson('{"version":2}')).toThrow(/not a SolarHome house model/);
  });

  it('keeps a traced outline within 5% of the true area', () => {
    const origin = { latitude: 51.503, longitude: -0.127 };
    const ring = unprojectRing(
      [
        { east: -5, north: -5 },
        { east: 5, north: -5 },
        { east: 5, north: 5 },
        { east: -5, north: 5 },
      ],
      origin,
    );
    const traced = assembleTrace(ring, rectangleModel('gable', 25, 90));
    expect(houseFootprintArea(traced)).toBeCloseTo(100, 1);
    expect(traced.provenance.footprint.source).toBe('user-trace');
  });

  it('reads height and roof from an assembled building', () => {
    const model = assembleHouse({
      label: 'Sample',
      tags: { height: '9', 'roof:shape': 'flat', building: 'yes' },
      parts: [
        {
          outer: unprojectRing(rectangle, { latitude: 40, longitude: -73 }),
          holes: [],
        },
      ],
      provenance: { source: 'osm', confidence: 0.8 },
    });
    expect(model.parts[0]?.eaveHeightM).toBe(9);
    expect(model.parts[0]?.roof.type).toBe('flat');
    expect(houseFootprintArea(model)).toBeCloseTo(96, 1);
  });
});

describe('roof meshes', () => {
  it('rebuilds when the roof type, pitch, or eave height changes', () => {
    const gable = buildHouseGeometries(rectangleModel('gable', 30, 90));
    const flat = buildHouseGeometries(rectangleModel('flat', 0, 0));
    const steeper = buildHouseGeometries(rectangleModel('gable', 45, 90));
    const taller = buildHouseGeometries(rectangleModel('gable', 30, 90, 6));
    expect(maxY(gable.roof)).toBeCloseTo(3 + 4 * Math.tan(Math.PI / 6), 2);
    expect(maxY(flat.roof)).toBeCloseTo(3, 4);
    expect(maxY(steeper.roof)).toBeGreaterThan(maxY(gable.roof));
    expect(maxY(taller.roof)).toBeCloseTo(6 + 4 * Math.tan(Math.PI / 6), 2);
  });

  it('closes the shell for flat, shed, gable, and hip roofs', () => {
    for (const type of ['flat', 'shed', 'gable', 'hip'] as const) {
      const built = buildHouseGeometries(rectangleModel(type, type === 'flat' ? 0 : 30, type === 'gable' || type === 'hip' ? 90 : 180));
      expect(openEdges(built.floor, built.walls, built.roof), type).toEqual([]);
    }
  });
});

function rectangleModel(type: RoofType, pitchDeg: number, directionDeg: number, eaveHeightM = 3): HouseModel {
  const note = { source: 'default' as const, confidence: 1 };
  return {
    version: 1,
    origin: { latitude: 39.74, longitude: -105.18 },
    orientationDeg: 0,
    parts: [
      {
        id: 'test',
        footprint: rectangle,
        holes: [],
        eaveHeightM,
        roof: { type, directionDeg, pitchDeg, overhangM: 0 },
      },
    ],
    provenance: { origin: note, orientation: note, footprint: note, eaveHeight: note, roof: note },
    issues: [],
    label: 'test',
  };
}

function cornerAngle(
  previous: { east: number; north: number } | undefined,
  current: { east: number; north: number },
  following: { east: number; north: number } | undefined,
): number {
  if (previous === undefined || following === undefined) return Number.NaN;
  const inEast = previous.east - current.east;
  const inNorth = previous.north - current.north;
  const outEast = following.east - current.east;
  const outNorth = following.north - current.north;
  const dot = inEast * outEast + inNorth * outNorth;
  const cross = inEast * outNorth - inNorth * outEast;
  return (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
}

function maxY(geometry: BufferGeometry): number {
  geometry.computeBoundingBox();
  return geometry.boundingBox?.max.y ?? Number.NaN;
}

function openEdges(...geometries: BufferGeometry[]): string[] {
  const counts = new Map<string, number>();
  for (const geometry of geometries) {
    const position = geometry.getAttribute('position');
    if (!(position instanceof BufferAttribute)) continue;
    for (let index = 0; index < position.count; index += 3) {
      const triangle = [0, 1, 2].map((offset) => vertex(position, index + offset));
      for (let edge = 0; edge < 3; edge += 1) {
        const start = triangle[edge];
        const end = triangle[(edge + 1) % 3];
        if (start === undefined || end === undefined) continue;
        if (distance3(start, end) < 0.001) continue;
        const key = edgeKey(start, end);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].filter(([, count]) => count !== 2).map(([key, count]) => `${key} x${count}`);
}

function vertex(position: BufferAttribute, index: number): [number, number, number] {
  return [position.getX(index), position.getY(index), position.getZ(index)];
}

function edgeKey(a: [number, number, number], b: [number, number, number]): string {
  const left = a.map((value) => Math.round(value * 1000)).join(',');
  const right = b.map((value) => Math.round(value * 1000)).join(',');
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function distance3(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
