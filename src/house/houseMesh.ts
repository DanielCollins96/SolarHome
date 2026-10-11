import earcut, { deviation } from 'earcut';
import { BufferAttribute, BufferGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import { centerPolygon, polygonCentroid, type PlanPoint } from './centering.ts';
import type { HouseModel, HousePart } from './houseModel.ts';
import { copyPoint, largestInset, offsetPolygon } from './planGeometry.ts';

export interface GableHouseSpec {
  footprint: readonly PlanPoint[];
  eaveHeight: number;
  pitchDegrees: number;
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

interface Hit {
  t: number;
  point: PlanPoint;
  edge: number;
  u: number;
}

const WALL_COLOR = 0xe4d2b0;
const ROOF_COLOR = 0x6b5344;
const FLOOR_COLOR = 0xcbb892;
const SLAB_M = 0.15;
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const DOWN: Vec3 = { x: 0, y: -1, z: 0 };

/**
 * Hardcoded demonstration footprint, stored off the origin so centering is exercised.
 * 12 m east-west, 8 m north-south.
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
  sourceCentroid: PlanPoint;
  width: number;
  depth: number;
  eaveHeight: number;
  ridgeHeight: number;
}

export interface BuiltHouse {
  walls: BufferGeometry;
  roof: BufferGeometry;
  floor: BufferGeometry;
  warnings: string[];
}

class Draft {
  readonly positions: number[] = [];
  readonly normals: number[] = [];

  add(a: Vec3, b: Vec3, c: Vec3): void {
    const normal = faceNormal(a, b, c);
    if (normal === null) return;
    for (const point of [a, b, c]) {
      this.positions.push(point.x, point.y, point.z);
      this.normals.push(normal.x, normal.y, normal.z);
    }
  }
}

/** Walls, roof, and floor for a centered house. Orientation is applied later, on the group. */
export function buildHouseGeometries(model: HouseModel): BuiltHouse {
  const walls = new Draft();
  const roof = new Draft();
  const floor = new Draft();
  const warnings: string[] = [];
  for (const part of model.parts) buildPart(part, walls, roof, floor, warnings);
  return {
    walls: draftToGeometry(walls),
    roof: draftToGeometry(roof),
    floor: draftToGeometry(floor),
    warnings,
  };
}

export function createHouseObject(model: HouseModel): { group: Group; warnings: string[] } {
  const group = new Group();
  group.name = 'house';
  const warnings: string[] = [];
  const buckets = new Map<string, HousePart[]>();
  for (const part of model.parts) {
    const key = part.sourceId ?? '';
    const list = buckets.get(key) ?? [];
    list.push(part);
    buckets.set(key, list);
  }
  for (const [key, parts] of buckets) {
    const built = buildHouseGeometries({ ...model, parts });
    warnings.push(...built.warnings);
    const piece = new Group();
    piece.name = 'building';
    if (key !== '') piece.userData.buildingId = key;
    piece.add(shadedMesh('house-floor', built.floor, FLOOR_COLOR, false));
    piece.add(shadedMesh('house-walls', built.walls, WALL_COLOR, true));
    piece.add(shadedMesh('house-roof', built.roof, ROOF_COLOR, true));
    group.add(piece);
  }
  // Positive Y rotation is clockwise viewed from above: plan-north turns toward east.
  group.rotation.y = (model.orientationDeg * Math.PI) / 180;
  return { group, warnings };
}

export function buildGableHouse(spec: GableHouseSpec): GableHouseGeometry {
  const centered = centerPolygon(spec.footprint);
  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  for (const point of centered.points) {
    minEast = Math.min(minEast, point.east);
    maxEast = Math.max(maxEast, point.east);
    minNorth = Math.min(minNorth, point.north);
    maxNorth = Math.max(maxNorth, point.north);
  }
  const model: HouseModel = {
    version: 1,
    origin: { latitude: 0, longitude: 0 },
    orientationDeg: 0,
    parts: [
      {
        id: 'gable',
        footprint: centered.points,
        holes: [],
        eaveHeightM: spec.eaveHeight,
        roof: { type: 'gable', directionDeg: 90, pitchDeg: spec.pitchDegrees, overhangM: 0 },
      },
    ],
    provenance: {
      origin: { source: 'default', confidence: 1 },
      orientation: { source: 'default', confidence: 1 },
      footprint: { source: 'default', confidence: 1 },
      eaveHeight: { source: 'default', confidence: 1 },
      roof: { source: 'default', confidence: 1 },
    },
    issues: [],
    label: 'gable',
  };
  const built = buildHouseGeometries(model);
  return {
    walls: built.walls,
    roof: built.roof,
    sourceCentroid: polygonCentroid(spec.footprint),
    width: maxEast - minEast,
    depth: maxNorth - minNorth,
    eaveHeight: spec.eaveHeight,
    ridgeHeight: built.roof.boundingBox?.max.y ?? spec.eaveHeight,
  };
}

export function createHouseGroup(spec: GableHouseSpec): Group {
  return createHouseObject(gableModel(spec)).group;
}

function gableModel(spec: GableHouseSpec): HouseModel {
  const centered = centerPolygon(spec.footprint);
  return {
    version: 1,
    origin: { latitude: 0, longitude: 0 },
    orientationDeg: 0,
    parts: [
      {
        id: 'gable',
        footprint: centered.points,
        holes: [],
        eaveHeightM: spec.eaveHeight,
        roof: { type: 'gable', directionDeg: 90, pitchDeg: spec.pitchDegrees, overhangM: 0 },
      },
    ],
    provenance: {
      origin: { source: 'default', confidence: 1 },
      orientation: { source: 'default', confidence: 1 },
      footprint: { source: 'default', confidence: 1 },
      eaveHeight: { source: 'default', confidence: 1 },
      roof: { source: 'default', confidence: 1 },
    },
    issues: [],
    label: 'gable',
  };
}

function buildPart(part: HousePart, walls: Draft, roof: Draft, floor: Draft, warnings: string[]): void {
  const footprint = part.footprint.map(copyPoint);
  if (footprint.length < 3) return;
  const slab = part.roof.overhangM > 0 ? SLAB_M : 0;
  const outline = roofOutline(footprint, part.roof.overhangM, warnings);
  const overhang = outline !== footprint && part.roof.overhangM > 0;

  if (part.holes.length > 0 && (part.roof.type === 'gable' || part.roof.type === 'hip')) {
    warnings.push('The courtyard is enclosed by walls, but it is not cut through this roof.');
  }

  if (part.roof.type === 'hip') {
    if (buildHip(part, footprint, outline, overhang, slab, walls, roof)) {
      addFloor(floor, footprint, part.holes);
      return;
    }
    warnings.push('This outline could not take a hip roof, so it was built as a gable.');
    part = { ...part, roof: { ...part.roof, type: 'gable' } };
  }

  const heightAt = heightFunction(part, footprint);
  const wallRing = part.roof.type === 'gable' ? expandForRidge(footprint, part.roof.directionDeg).ring : footprint;
  addFloor(floor, wallRing, part.holes);
  addWalls(walls, wallRing, (point) => Math.max(0, heightAt(point) - slab));
  for (const hole of part.holes) addWalls(walls, [...hole].reverse(), () => Math.max(0, part.eaveHeightM - slab));

  if (part.roof.type === 'gable') {
    addGableRoof(roof, outline, part.roof.directionDeg, heightAt);
  } else if (part.roof.type === 'flat') {
    addCap(roof, outline, part.holes, part.eaveHeightM, true);
  } else {
    addHeightedCap(roof, outline, part.holes, heightAt, true);
  }

  if (overhang) addOverhang(roof, footprint, outline, part, heightAt, slab);
}

function buildHip(
  part: HousePart,
  footprint: PlanPoint[],
  outline: PlanPoint[],
  overhang: boolean,
  slab: number,
  walls: Draft,
  roof: Draft,
): boolean {
  const inset = largestInset(footprint);
  if (inset === null || inset.ring.length !== footprint.length) return false;
  const pitch = (part.roof.pitchDeg * Math.PI) / 180;
  const rise = inset.distance * Math.tan(pitch);
  const drop = overhang ? part.roof.overhangM * Math.tan(pitch) : 0;
  const eave = part.eaveHeightM;
  addWalls(walls, footprint, () => Math.max(0, eave - slab));
  for (const hole of part.holes) addWalls(walls, [...hole].reverse(), () => Math.max(0, eave - slab));
  for (let i = 0; i < outline.length; i++) {
    const outerA = outline[i];
    const outerB = outline[(i + 1) % outline.length];
    const innerA = inset.ring[i];
    const innerB = inset.ring[(i + 1) % inset.ring.length];
    if (outerA === undefined || outerB === undefined || innerA === undefined || innerB === undefined) continue;
    addQuad(
      roof,
      scene(outerA, eave - drop),
      scene(outerB, eave - drop),
      scene(innerB, eave + rise),
      scene(innerA, eave + rise),
      UP,
    );
  }
  addCap(roof, inset.ring, [], eave + rise, true);
  if (overhang) {
    const constant = () => eave;
    addOverhangBands(roof, footprint, outline, constant, () => eave - drop, slab);
  }
  return true;
}

function addGableRoof(draft: Draft, ring: PlanPoint[], directionDeg: number, heightAt: (point: PlanPoint) => number): void {
  const expanded = expandForRidge(ring, directionDeg);
  if (expanded.ridgeA < 0 || expanded.ridgeB < 0) {
    addHeightedCap(draft, ring, [], heightAt, true);
    return;
  }
  for (const chain of [chainBetween(expanded.ring, expanded.ridgeA, expanded.ridgeB), chainBetween(expanded.ring, expanded.ridgeB, expanded.ridgeA)]) {
    if (chain.length < 3) continue;
    addHeightedCap(draft, chain, [], heightAt, true);
  }
}

function addOverhang(
  draft: Draft,
  footprint: PlanPoint[],
  outline: PlanPoint[],
  part: HousePart,
  heightAt: (point: PlanPoint) => number,
  slab: number,
): void {
  if (part.roof.type === 'gable') {
    const inner = expandForRidge(footprint, part.roof.directionDeg).ring;
    const outer = expandForRidge(outline, part.roof.directionDeg).ring;
    if (inner.length !== outer.length) return;
    addPairedOverhang(draft, inner, outer, heightAt, slab);
    return;
  }
  addOverhangBands(draft, footprint, outline, heightAt, heightAt, slab);
}

function addPairedOverhang(
  draft: Draft,
  inner: PlanPoint[],
  outer: PlanPoint[],
  heightAt: (point: PlanPoint) => number,
  slab: number,
): void {
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    const d = outer[(i + 1) % outer.length];
    const c = outer[i];
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    addQuad(draft, scene(a, heightAt(a) - slab), scene(b, heightAt(b) - slab), scene(d, heightAt(d) - slab), scene(c, heightAt(c) - slab), DOWN);
    addQuad(draft, scene(c, heightAt(c)), scene(d, heightAt(d)), scene(d, heightAt(d) - slab), scene(c, heightAt(c) - slab), outwardScene(c, d));
  }
}

function addOverhangBands(
  draft: Draft,
  inner: PlanPoint[],
  outer: PlanPoint[],
  innerHeight: (point: PlanPoint) => number,
  outerHeight: (point: PlanPoint) => number,
  slab: number,
): void {
  if (inner.length !== outer.length) return;
  addPairedHeights(draft, inner, outer, innerHeight, outerHeight, slab);
}

function addPairedHeights(
  draft: Draft,
  inner: PlanPoint[],
  outer: PlanPoint[],
  innerHeight: (point: PlanPoint) => number,
  outerHeight: (point: PlanPoint) => number,
  slab: number,
): void {
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    const d = outer[(i + 1) % outer.length];
    const c = outer[i];
    if (a === undefined || b === undefined || c === undefined || d === undefined) continue;
    addQuad(
      draft,
      scene(a, innerHeight(a) - slab),
      scene(b, innerHeight(b) - slab),
      scene(d, outerHeight(d) - slab),
      scene(c, outerHeight(c) - slab),
      DOWN,
    );
    addQuad(
      draft,
      scene(c, outerHeight(c)),
      scene(d, outerHeight(d)),
      scene(d, outerHeight(d) - slab),
      scene(c, outerHeight(c) - slab),
      outwardScene(c, d),
    );
  }
}

function addWalls(draft: Draft, ring: readonly PlanPoint[], top: (point: PlanPoint) => number): void {
  for (let i = 0; i < ring.length; i++) {
    const start = ring[i];
    const end = ring[(i + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    const topStart = top(start);
    const topEnd = top(end);
    addQuad(draft, scene(start, 0), scene(end, 0), scene(end, topEnd), scene(start, topStart), outwardScene(start, end));
  }
}

function addFloor(draft: Draft, outer: PlanPoint[], holes: PlanPoint[][]): void {
  addCap(draft, outer, holes, 0, false);
}

function addCap(draft: Draft, outer: PlanPoint[], holes: PlanPoint[][], y: number, upward: boolean): void {
  addHeightedCap(draft, outer, holes, () => y, upward);
}

function addHeightedCap(
  draft: Draft,
  outer: PlanPoint[],
  holes: PlanPoint[][],
  heightAt: (point: PlanPoint) => number,
  upward: boolean,
): void {
  const points = outer.map(copyPoint);
  const holeStarts: number[] = [];
  for (const hole of holes) {
    holeStarts.push(points.length);
    points.push(...hole);
  }
  const data = points.flatMap((point) => [point.east, point.north]);
  const holeIndices = holeStarts.length > 0 ? holeStarts : null;
  let triangles = earcut(data, holeIndices);
  if (holeIndices !== null && deviation(data, holeIndices, 2, triangles) > 1e-4) {
    const reversed = outer.map(copyPoint);
    const reversedHoles: number[] = [];
    for (const hole of holes) {
      reversedHoles.push(reversed.length);
      reversed.push(...[...hole].reverse());
    }
    const reversedData = reversed.flatMap((point) => [point.east, point.north]);
    const retry = earcut(reversedData, reversedHoles);
    if (deviation(reversedData, reversedHoles, 2, retry) < deviation(data, holeIndices, 2, triangles)) {
      points.splice(0, points.length, ...reversed);
      triangles = retry;
    }
  }
  for (let i = 0; i < triangles.length; i += 3) {
    const ia = triangles[i];
    const ib = triangles[i + 1];
    const ic = triangles[i + 2];
    const a = points[ia ?? -1];
    const b = points[ib ?? -1];
    const c = points[ic ?? -1];
    if (a === undefined || b === undefined || c === undefined) continue;
    let first = scene(a, heightAt(a));
    let second = scene(b, heightAt(b));
    let third = scene(c, heightAt(c));
    const normal = faceNormal(first, second, third);
    if (normal !== null && ((upward && normal.y < 0) || (!upward && normal.y > 0))) {
      const swap = second;
      second = third;
      third = swap;
    }
    draft.add(first, second, third);
  }
}

function heightFunction(part: HousePart, footprint: PlanPoint[]): (point: PlanPoint) => number {
  const pitch = Math.tan((part.roof.pitchDeg * Math.PI) / 180);
  if (part.roof.type === 'flat' || pitch === 0) return () => part.eaveHeightM;
  if (part.roof.type === 'shed') {
    const down = azimuth(part.roof.directionDeg);
    const upEast = -down.east;
    const upNorth = -down.north;
    let minAlong = Infinity;
    for (const point of footprint) minAlong = Math.min(minAlong, point.east * upEast + point.north * upNorth);
    return (point) => part.eaveHeightM + (point.east * upEast + point.north * upNorth - minAlong) * pitch;
  }
  const frame = ridgeFrame(footprint, part.roof.directionDeg);
  return (point) => {
    const signed = (point.east - frame.origin.east) * frame.perpEast + (point.north - frame.origin.north) * frame.perpNorth;
    return part.eaveHeightM + (frame.maxDist - Math.abs(signed)) * pitch;
  };
}

function roofOutline(footprint: PlanPoint[], overhangM: number, warnings: string[]): PlanPoint[] {
  if (overhangM <= 0) return footprint;
  const outlined = offsetPolygon(footprint, overhangM);
  if (outlined === null || outlined.length !== footprint.length) {
    warnings.push('The overhang could not follow this outline, so the roof stops at the walls.');
    return footprint;
  }
  return outlined;
}

function expandForRidge(ring: PlanPoint[], directionDeg: number): { ring: PlanPoint[]; ridgeA: number; ridgeB: number } {
  const frame = ridgeFrame(ring, directionDeg);
  const hits = ridgeHits(ring, frame.origin, frame.alongEast, frame.alongNorth);
  const negative = hits.filter((hit) => hit.t < -1e-4).sort((a, b) => b.t - a.t)[0];
  const positive = hits.filter((hit) => hit.t > 1e-4).sort((a, b) => a.t - b.t)[0];
  if (negative === undefined || positive === undefined) return { ring, ridgeA: -1, ridgeB: -1 };

  const extras = new Map<number, Hit[]>();
  for (const hit of [negative, positive]) {
    if (hit.u <= 1e-4 || hit.u >= 1 - 1e-4) continue;
    const list = extras.get(hit.edge) ?? [];
    list.push(hit);
    extras.set(hit.edge, list);
  }
  const expanded: PlanPoint[] = [];
  const ridgeIndexes: number[] = [];
  const mark = (point: PlanPoint, index: number) => {
    if (samePoint(point, negative.point) || samePoint(point, positive.point)) ridgeIndexes.push(index);
  };
  for (let i = 0; i < ring.length; i++) {
    const vertex = ring[i];
    if (vertex === undefined) continue;
    mark(vertex, expanded.length);
    expanded.push(vertex);
    const inserted = (extras.get(i) ?? []).sort((a, b) => a.u - b.u);
    for (const hit of inserted) {
      mark(hit.point, expanded.length);
      expanded.push(hit.point);
    }
  }
  return { ring: expanded, ridgeA: ridgeIndexes[0] ?? -1, ridgeB: ridgeIndexes[1] ?? -1 };
}

function chainBetween(ring: PlanPoint[], start: number, end: number): PlanPoint[] {
  const chain: PlanPoint[] = [];
  let index = start;
  for (let guard = 0; guard <= ring.length; guard++) {
    const point = ring[index];
    if (point === undefined) break;
    chain.push(point);
    if (index === end) break;
    index = (index + 1) % ring.length;
  }
  return chain;
}

function ridgeFrame(ring: readonly PlanPoint[], directionDeg: number): {
  origin: PlanPoint;
  alongEast: number;
  alongNorth: number;
  perpEast: number;
  perpNorth: number;
  maxDist: number;
} {
  const along = azimuth(directionDeg);
  const origin = polygonCentroid(ring);
  const perpEast = -along.north;
  const perpNorth = along.east;
  let maxDist = 0;
  for (const point of ring) {
    maxDist = Math.max(maxDist, Math.abs((point.east - origin.east) * perpEast + (point.north - origin.north) * perpNorth));
  }
  return { origin, alongEast: along.east, alongNorth: along.north, perpEast, perpNorth, maxDist };
}

function ridgeHits(ring: readonly PlanPoint[], origin: PlanPoint, dirEast: number, dirNorth: number): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < ring.length; i++) {
    const start = ring[i];
    const end = ring[(i + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    const edgeEast = end.east - start.east;
    const edgeNorth = end.north - start.north;
    const det = dirEast * -edgeNorth + dirNorth * edgeEast;
    if (Math.abs(det) < 1e-10) continue;
    const rhsEast = start.east - origin.east;
    const rhsNorth = start.north - origin.north;
    const t = (rhsEast * -edgeNorth - -edgeEast * rhsNorth) / det;
    const u = (dirEast * rhsNorth - dirNorth * rhsEast) / det;
    if (u < -1e-4 || u > 1 + 1e-4) continue;
    const clamped = Math.min(1, Math.max(0, u));
    hits.push({
      t,
      u: clamped,
      edge: i,
      point: { east: start.east + clamped * edgeEast, north: start.north + clamped * edgeNorth },
    });
  }
  return hits;
}

function azimuth(degrees: number): { east: number; north: number } {
  const radians = (degrees * Math.PI) / 180;
  return { east: Math.sin(radians), north: Math.cos(radians) };
}

function samePoint(a: PlanPoint, b: PlanPoint): boolean {
  return Math.hypot(a.east - b.east, a.north - b.north) < 1e-4;
}

function addQuad(draft: Draft, a: Vec3, b: Vec3, c: Vec3, d: Vec3, facing: Vec3): void {
  const normal = faceNormal(a, b, c);
  if (normal !== null && dot(normal, facing) < 0) {
    draft.add(a, d, c);
    draft.add(a, c, b);
    return;
  }
  draft.add(a, b, c);
  draft.add(a, c, d);
}

function scene(point: PlanPoint, y: number): Vec3 {
  return { x: point.east, y, z: -point.north };
}

function outwardScene(start: PlanPoint, end: PlanPoint): Vec3 {
  const edgeEast = end.east - start.east;
  const edgeNorth = end.north - start.north;
  const length = Math.hypot(edgeEast, edgeNorth) || 1;
  return { x: edgeNorth / length, y: 0, z: edgeEast / length };
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
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
  if (length < 1e-8) return null;
  return { x: x / length, y: y / length, z: z / length };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function draftToGeometry(draft: Draft): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(draft.positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(draft.normals), 3));
  geometry.computeBoundingBox();
  return geometry;
}

function shadedMesh(name: string, geometry: BufferGeometry, color: number, cast: boolean): Mesh {
  const mesh = new Mesh(geometry, new MeshLambertMaterial({ color }));
  mesh.name = name;
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  return mesh;
}
