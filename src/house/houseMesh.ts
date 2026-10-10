import { BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import { centerPolygon, polygonCentroid, type PlanPoint } from './centering.ts';

export interface GableHouseSpec {
  /** Simple ring, counter-clockwise in plan. It does not have to be centered. */
  footprint: readonly PlanPoint[];
  eaveHeight: number;
  /** Roof pitch in degrees, measured from horizontal. */
  pitchDegrees: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface GeometryDraft {
  positions: number[];
  normals: number[];
}

const WALL_COLOR = 0xe4d2b0;
const ROOF_COLOR = 0x6b5344;

/**
 * Hardcoded demonstration house.
 * The footprint is stored away from the origin so centering has a real offset to remove.
 * Width is east-west, depth is north-south, and the ridge runs east-west.
 */
export function demoFootprint(): PlanPoint[] {
  const width = 12;
  const depth = 8;
  const east0 = -width / 2 + 4;
  const north0 = -depth / 2 - 3;
  return [
    { east: east0, north: north0 },
    { east: east0 + width, north: north0 },
    { east: east0 + width, north: north0 + depth },
    { east: east0, north: north0 + depth },
  ];
}

export const DEMO_GABLE_HOUSE: GableHouseSpec = {
  footprint: demoFootprint(),
  eaveHeight: 3,
  pitchDegrees: 30,
};

export interface GableHouseGeometry {
  walls: BufferGeometry;
  roof: BufferGeometry;
  /** Centroid of the footprint before it was moved to the origin. */
  sourceCentroid: PlanPoint;
  width: number;
  depth: number;
  eaveHeight: number;
  ridgeHeight: number;
}

/**
 * Extrude an axis-aligned rectangular footprint into walls and a gable roof.
 * The result is centered: footprint centroid at x = 0, z = 0, ground at y = 0.
 * Scene axes: X = east, Y = up, Z = south.
 *
 * M1 only accepts an axis-aligned rectangle. Other polygons arrive with the
 * house-generation pipeline in M2.
 */
export function buildGableHouse(spec: GableHouseSpec): GableHouseGeometry {
  if (spec.eaveHeight <= 0) {
    throw new Error('Eave height must be positive.');
  }
  if (spec.pitchDegrees <= 0 || spec.pitchDegrees >= 89) {
    throw new Error('Pitch must be between 0 and 89 degrees.');
  }

  const centered = centerPolygon(spec.footprint);
  const span = rectangleSpan(centered.points);
  const rise = (span.depth / 2) * Math.tan((spec.pitchDegrees * Math.PI) / 180);
  const ridgeHeight = spec.eaveHeight + rise;
  const halfWidth = span.width / 2;
  const halfDepth = span.depth / 2;
  const eave = spec.eaveHeight;

  const walls = createDraft();
  const roof = createDraft();

  // South wall, outward normal +Z.
  addQuad(
    walls,
    { x: -halfWidth, y: 0, z: halfDepth },
    { x: halfWidth, y: 0, z: halfDepth },
    { x: halfWidth, y: eave, z: halfDepth },
    { x: -halfWidth, y: eave, z: halfDepth },
  );
  // North wall, outward normal -Z.
  addQuad(
    walls,
    { x: halfWidth, y: 0, z: -halfDepth },
    { x: -halfWidth, y: 0, z: -halfDepth },
    { x: -halfWidth, y: eave, z: -halfDepth },
    { x: halfWidth, y: eave, z: -halfDepth },
  );
  // East gable, outward normal +X.
  addFan(walls, [
    { x: halfWidth, y: 0, z: halfDepth },
    { x: halfWidth, y: 0, z: -halfDepth },
    { x: halfWidth, y: eave, z: -halfDepth },
    { x: halfWidth, y: ridgeHeight, z: 0 },
    { x: halfWidth, y: eave, z: halfDepth },
  ]);
  // West gable, outward normal -X.
  addFan(walls, [
    { x: -halfWidth, y: 0, z: -halfDepth },
    { x: -halfWidth, y: 0, z: halfDepth },
    { x: -halfWidth, y: eave, z: halfDepth },
    { x: -halfWidth, y: ridgeHeight, z: 0 },
    { x: -halfWidth, y: eave, z: -halfDepth },
  ]);

  // South slope, outward normal up and south. Ridge runs along X.
  addQuad(
    roof,
    { x: -halfWidth, y: eave, z: halfDepth },
    { x: halfWidth, y: eave, z: halfDepth },
    { x: halfWidth, y: ridgeHeight, z: 0 },
    { x: -halfWidth, y: ridgeHeight, z: 0 },
  );
  // North slope, outward normal up and north.
  addQuad(
    roof,
    { x: halfWidth, y: eave, z: -halfDepth },
    { x: -halfWidth, y: eave, z: -halfDepth },
    { x: -halfWidth, y: ridgeHeight, z: 0 },
    { x: halfWidth, y: ridgeHeight, z: 0 },
  );

  return {
    walls: draftToGeometry(walls),
    roof: draftToGeometry(roof),
    sourceCentroid: polygonCentroid(spec.footprint),
    width: span.width,
    depth: span.depth,
    eaveHeight: spec.eaveHeight,
    ridgeHeight,
  };
}

export function createHouseGroup(spec: GableHouseSpec): Group {
  const built = buildGableHouse(spec);
  const walls = new Mesh(built.walls, new MeshLambertMaterial({ color: WALL_COLOR }));
  const roof = new Mesh(built.roof, new MeshLambertMaterial({ color: ROOF_COLOR }));
  walls.name = 'house-walls';
  roof.name = 'house-roof';
  walls.castShadow = true;
  walls.receiveShadow = true;
  roof.castShadow = true;
  roof.receiveShadow = true;

  const group = new Group();
  group.name = 'house';
  group.add(walls, roof);
  return group;
}

function rectangleSpan(points: readonly PlanPoint[]): { width: number; depth: number } {
  if (points.length !== 4) {
    throw new Error('M1 gable house expects a 4-vertex axis-aligned rectangle.');
  }

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

  const width = maxEast - minEast;
  const depth = maxNorth - minNorth;
  if (width < 1e-6 || depth < 1e-6) {
    throw new Error('Footprint rectangle has no area.');
  }

  const corners = [
    [minEast, minNorth],
    [minEast, maxNorth],
    [maxEast, minNorth],
    [maxEast, maxNorth],
  ];
  for (const point of points) {
    const matched = corners.some(
      ([east, north]) =>
        east !== undefined &&
        north !== undefined &&
        Math.abs(point.east - east) < 1e-6 &&
        Math.abs(point.north - north) < 1e-6,
    );
    if (!matched) {
      throw new Error('M1 gable house only accepts an axis-aligned rectangle.');
    }
  }

  return { width, depth };
}

function addQuad(draft: GeometryDraft, a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
  addTriangle(draft, a, b, c);
  addTriangle(draft, a, c, d);
}

function addFan(draft: GeometryDraft, ring: readonly Vec3[]): void {
  const first = ring[0];
  if (first === undefined) return;
  for (let i = 1; i < ring.length - 1; i++) {
    const b = ring[i];
    const c = ring[i + 1];
    if (b === undefined || c === undefined) continue;
    addTriangle(draft, first, b, c);
  }
}

function addTriangle(draft: GeometryDraft, a: Vec3, b: Vec3, c: Vec3): void {
  const normal = faceNormal(a, b, c);
  for (const point of [a, b, c]) {
    draft.positions.push(point.x, point.y, point.z);
    draft.normals.push(normal.x, normal.y, normal.z);
  }
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;
  const x = aby * acz - abz * acy;
  const y = abz * acx - abx * acz;
  const z = abx * acy - aby * acx;
  const length = Math.hypot(x, y, z);
  if (length < 1e-10) {
    throw new Error('House face is degenerate.');
  }
  return { x: x / length, y: y / length, z: z / length };
}

function draftToGeometry(draft: GeometryDraft): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(draft.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(draft.normals), 3));
  geometry.computeBoundingBox();
  return geometry;
}

function createDraft(): GeometryDraft {
  return { positions: [], normals: [] };
}
