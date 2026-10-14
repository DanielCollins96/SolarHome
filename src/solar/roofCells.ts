import { buildHouseGeometries } from '../house/houseMesh.ts';
import type { HouseModel } from '../house/houseModel.ts';
import { createRayBlocker } from './rays.ts';

/** Side of one heatmap square, measured along the roof's slope. */
export const CELL_M = 1;
/** Steeper than this is a wall or the edge of an overhang, not somewhere to put a panel. */
const STEEPEST_ROOF_DEG = 75;
/** Sub-samples per side when measuring how much of a square lies on the roof. */
const COVER_STEPS = 8;
/** Normals closer than this, about 1.5°, belong to the same plane. */
const SAME_NORMAL = 0.9997;
const SAME_PLANE_M = 0.03;

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * One flat piece of roof in scene metres (X east, Y up, Z south), with the model's rotation
 * already applied. `u` runs level across the slope and `v` runs up it, so the grid lines up with
 * the eaves the way panels would.
 */
export interface RoofFace {
  /** The building this face belongs to: its parts' `sourceId`, or '' for a model of one unnamed building. */
  building: string;
  normal: Vec3;
  /** Degrees from horizontal. */
  tiltDeg: number;
  /** Clockwise from north, the way the face looks downhill. Meaningless for a flat face. */
  azimuthDeg: number;
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** Grid size in squares. Square (col, row) spans u ∈ [col, col+1), v ∈ [row, row+1) metres from the origin. */
  cols: number;
  rows: number;
  /** Triangles of this face, nine floats each, in scene metres. */
  triangles: Float32Array;
}

/** One heatmap square: where its sunlight is measured, and how much of it is roof. */
export interface RoofCell {
  face: number;
  col: number;
  row: number;
  /** A point on the roof inside the square, preferably its centre. */
  point: Vec3;
  /** Square metres of roof in this square, up to CELL_M². */
  areaM2: number;
}

export interface RoofGrid {
  faces: RoofFace[];
  cells: RoofCell[];
}

/** The roof of every part, split into flat faces, each covered with a grid of squares. */
export function roofGrid(model: HouseModel): RoofGrid {
  const built = buildHouseGeometries(model);
  const turn = turnFor(model.orientationDeg);
  // Each building's roof on its own, so every face knows whose roof it is.
  const buildings = new Map<string, HouseModel['parts']>();
  for (const part of model.parts) {
    const key = part.sourceId ?? '';
    buildings.set(key, [...(buildings.get(key) ?? []), part]);
  }
  const triangles: { a: Vec3; b: Vec3; c: Vec3; normal: Vec3; building: string }[] = [];
  for (const [building, parts] of buildings) {
    const own = buildHouseGeometries({ ...model, parts });
    const position = own.roof.getAttribute('position');
    for (let i = 0; i + 2 < position.count; i += 3) {
      const a = turn({ x: position.getX(i), y: position.getY(i), z: position.getZ(i) });
      const b = turn({ x: position.getX(i + 1), y: position.getY(i + 1), z: position.getZ(i + 1) });
      const c = turn({ x: position.getX(i + 2), y: position.getY(i + 2), z: position.getZ(i + 2) });
      const normal = faceNormal(a, b, c);
      if (normal === null || normal.y < Math.cos((STEEPEST_ROOF_DEG * Math.PI) / 180)) continue;
      triangles.push({ a, b, c, normal, building });
    }
    own.walls.dispose();
    own.roof.dispose();
    own.floor.dispose();
  }
  // Every surface of the model, to find roof that is buried inside another part.
  const solid: number[] = [];
  for (const geometry of [built.walls, built.roof, built.floor]) {
    const surface = geometry.getAttribute('position');
    for (let i = 0; i < surface.count; i++) {
      const point = turn({ x: surface.getX(i), y: surface.getY(i), z: surface.getZ(i) });
      solid.push(point.x, point.y, point.z);
    }
  }
  const buried = buriedTest(Float32Array.from(solid));
  built.walls.dispose();
  built.roof.dispose();
  built.floor.dispose();

  // Gather triangles that share a plane. A roof has few faces, so a linear search is fine.
  const planes: { normal: Vec3; offset: number; building: string; members: typeof triangles }[] = [];
  for (const triangle of triangles) {
    const offset = dot(triangle.normal, triangle.a);
    const plane = planes.find(
      (item) => item.building === triangle.building && dot(item.normal, triangle.normal) > SAME_NORMAL && Math.abs(item.offset - offset) < SAME_PLANE_M,
    );
    if (plane === undefined) planes.push({ normal: triangle.normal, offset, building: triangle.building, members: [triangle] });
    else plane.members.push(triangle);
  }

  const faces: RoofFace[] = [];
  const cells: RoofCell[] = [];
  for (const plane of planes) {
    const normal = plane.normal;
    const u = levelAcross(normal);
    const v = cross(normal, u);
    const flat = plane.members.map((triangle) => [triangle.a, triangle.b, triangle.c].map((point) => ({ u: dot(point, u), v: dot(point, v) })));
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (const corner of flat.flat()) {
      minU = Math.min(minU, corner.u);
      minV = Math.min(minV, corner.v);
      maxU = Math.max(maxU, corner.u);
      maxV = Math.max(maxV, corner.v);
    }
    // Start the rows at the eaves, so the lowest full row of squares sits along the gutter.
    const cols = Math.max(1, Math.ceil((maxU - minU) / CELL_M - 1e-6));
    const rows = Math.max(1, Math.ceil((maxV - minV) / CELL_M - 1e-6));
    const along = plane.offset;
    const origin = add(add(scale(u, minU), scale(v, minV)), scale(normal, along));
    const index = faces.length;
    const soup = new Float32Array(plane.members.length * 9);
    plane.members.forEach((triangle, i) => soup.set([triangle.a, triangle.b, triangle.c].flatMap((p) => [p.x, p.y, p.z]), i * 9));
    const tiltDeg = (Math.acos(Math.min(1, normal.y)) * 180) / Math.PI;
    const azimuthDeg = ((Math.atan2(normal.x, -normal.z) * 180) / Math.PI + 360) % 360;
    faces.push({ building: plane.building, normal, tiltDeg, azimuthDeg, origin, u, v, cols, rows, triangles: soup });

    // Each triangle marks the sub-samples and centres it covers, visiting only the squares under it.
    // A face spread over a large building, like many flat roofs at one height, would otherwise test
    // every triangle at every sample of its whole bounding box.
    const covered = new Map<number, { samples: Uint8Array; center: boolean }>();
    for (const [a, b, c] of flat) {
      if (a === undefined || b === undefined || c === undefined) continue;
      const fromU = Math.max(0, Math.floor(((Math.min(a.u, b.u, c.u) - minU) / CELL_M) * COVER_STEPS - 0.5));
      const toU = Math.min(cols * COVER_STEPS - 1, Math.ceil(((Math.max(a.u, b.u, c.u) - minU) / CELL_M) * COVER_STEPS - 0.5));
      const fromV = Math.max(0, Math.floor(((Math.min(a.v, b.v, c.v) - minV) / CELL_M) * COVER_STEPS - 0.5));
      const toV = Math.min(rows * COVER_STEPS - 1, Math.ceil(((Math.max(a.v, b.v, c.v) - minV) / CELL_M) * COVER_STEPS - 0.5));
      for (let su = fromU; su <= toU; su++) {
        const col = Math.floor(su / COVER_STEPS);
        const i = su % COVER_STEPS;
        for (let sv = fromV; sv <= toV; sv++) {
          const row = Math.floor(sv / COVER_STEPS);
          const j = sv % COVER_STEPS;
          const key = row * cols + col;
          let cell = covered.get(key);
          const pu = minU + (col + (i + 0.5) / COVER_STEPS) * CELL_M;
          const pv = minV + (row + (j + 0.5) / COVER_STEPS) * CELL_M;
          if (cell?.samples[i * COVER_STEPS + j] !== 1 && inTriangle(pu, pv, a, b, c)) {
            if (cell === undefined) covered.set(key, (cell = { samples: new Uint8Array(COVER_STEPS * COVER_STEPS), center: false }));
            cell.samples[i * COVER_STEPS + j] = 1;
          }
          // The centre lies between samples 3 and 4, so any triangle that reaches it also reaches sample 4.
          if (i === COVER_STEPS / 2 && j === COVER_STEPS / 2 && cell?.center !== true) {
            if (inTriangle(minU + (col + 0.5) * CELL_M, minV + (row + 0.5) * CELL_M, a, b, c)) {
              if (cell === undefined) covered.set(key, (cell = { samples: new Uint8Array(COVER_STEPS * COVER_STEPS), center: false }));
              cell.center = true;
            }
          }
        }
      }
    }
    // Row by row, as the squares were always listed.
    for (const key of [...covered.keys()].sort((p, q) => p - q)) {
      const cover = covered.get(key);
      if (cover === undefined) continue;
      const row = Math.floor(key / cols);
      const col = key % cols;
      let hits = 0;
      let sumU = 0;
      let sumV = 0;
      for (let i = 0; i < COVER_STEPS; i++) {
        for (let j = 0; j < COVER_STEPS; j++) {
          if (cover.samples[i * COVER_STEPS + j] !== 1) continue;
          hits++;
          sumU += minU + (col + (i + 0.5) / COVER_STEPS) * CELL_M;
          sumV += minV + (row + (j + 0.5) / COVER_STEPS) * CELL_M;
        }
      }
      if (hits === 0) continue;
      // A square cut by the roof's edge is measured where its roof is, not out over the gutter.
      const [pu, pv] = cover.center ? [minU + (col + 0.5) * CELL_M, minV + (row + 0.5) * CELL_M] : [sumU / hits, sumV / hits];
      const point = add(add(scale(u, pu), scale(v, pv)), scale(normal, along));
      if (buried(point, normal)) continue;
      cells.push({
        face: index,
        col,
        row,
        point,
        areaM2: (hits / (COVER_STEPS * COVER_STEPS)) * CELL_M * CELL_M,
      });
    }
  }
  return { faces, cells };
}

/**
 * True for a point of roof inside another part of the model, such as a porch roof that runs on
 * under the main roof. Looking straight up from inside a part, the first surface seen is the
 * back of its roof. From open air, it is sky, or the downward face of an overhang.
 */
function buriedTest(solid: Float32Array): (point: Vec3, normal: Vec3) => boolean {
  const blocker = createRayBlocker(solid);
  const lift = 0.05;
  return (point, normal) => {
    const hit = blocker.nearest(point.x + normal.x * lift, point.y + normal.y * lift, point.z + normal.z * lift, 0, 1, 0);
    if (hit < 0) return false;
    const base = hit * 9;
    const at = (k: number) => ({ x: solid[base + k] ?? 0, y: solid[base + k + 1] ?? 0, z: solid[base + k + 2] ?? 0 });
    const facing = faceNormal(at(0), at(3), at(6));
    return facing !== null && facing.y > 0.01;
  };
}

/** Matches the house group's rotation: positive Y turns plan-north toward east. */
function turnFor(orientationDeg: number): (point: Vec3) => Vec3 {
  if (orientationDeg === 0) return (point) => point;
  const angle = (orientationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return (point) => ({ x: point.x * cos + point.z * sin, y: point.y, z: -point.x * sin + point.z * cos });
}

/** A level direction in the face. A flat face uses east. */
function levelAcross(normal: Vec3): Vec3 {
  const length = Math.hypot(normal.x, normal.z);
  if (length < 1e-6) return { x: 1, y: 0, z: 0 };
  // Facing the roof from downhill, u runs left to right, and u × v is the normal.
  return { x: normal.z / length, y: 0, z: -normal.x / length };
}

function inTriangle(pu: number, pv: number, a: { u: number; v: number }, b: { u: number; v: number }, c: { u: number; v: number }): boolean {
  const d1 = (pu - b.u) * (a.v - b.v) - (a.u - b.u) * (pv - b.v);
  const d2 = (pu - c.u) * (b.v - c.v) - (b.u - c.u) * (pv - c.v);
  const d3 = (pu - a.u) * (c.v - a.v) - (c.u - a.u) * (pv - a.v);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 | null {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(n.x, n.y, n.z);
  return length < 1e-8 ? null : scale(n, 1 / length);
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scale(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
