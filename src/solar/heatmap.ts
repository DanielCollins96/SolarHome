import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  SRGBColorSpace,
  Vector3,
  type Object3D,
} from 'three';
import type { PlanPoint } from '../house/centering.ts';
import { buildHouseGeometries } from '../house/houseMesh.ts';
import type { HouseModel } from '../house/houseModel.ts';
import { createBlockGroup } from '../scene/blockMesh.ts';
import { createTreeGroup, type TreeSpec } from '../scene/treeMesh.ts';
import type { Occluders } from './exposure.ts';
import { CELL_M, type RoofGrid } from './roofCells.ts';

/** Texture pixels per square, so each square gets a thin darker border. */
const PIXELS_PER_CELL = 8;
/** Sit just above the roof so the colours never fight it for depth. */
const OVERLAY_LIFT_M = 0.03;

/** Low to high: deep purple through red and orange to pale yellow, like the "inferno" scale. */
export const HEAT_STOPS: readonly [number, number, number, number][] = [
  [0, 0x1b, 0x0c, 0x41],
  [0.25, 0x6a, 0x17, 0x6e],
  [0.5, 0xbc, 0x37, 0x54],
  [0.7, 0xed, 0x69, 0x25],
  [0.85, 0xfb, 0xb6, 0x1a],
  [1, 0xfc, 0xff, 0xa4],
];

export function heatColor(share: number): [number, number, number] {
  const value = Math.min(1, Math.max(0, share));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const high = HEAT_STOPS[i];
    const low = HEAT_STOPS[i - 1];
    if (high === undefined || low === undefined || value > high[0]) continue;
    const t = (value - low[0]) / (high[0] - low[0]);
    return [low[1] + (high[1] - low[1]) * t, low[2] + (high[2] - low[2]) * t, low[3] + (high[3] - low[3]) * t];
  }
  return [0xfc, 0xff, 0xa4];
}

/** A CSS gradient matching the heat colours, for the legend. */
export function heatGradientCss(): string {
  const stops = HEAT_STOPS.map(([at, r, g, b]) => `rgb(${r} ${g} ${b}) ${Math.round(at * 100)}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/**
 * Everything that can shade the roof, as triangles in the model's metres: the selected buildings
 * themselves, the neighbouring blocks, and the trees split by kind.
 */
export function collectOccluders(
  model: HouseModel,
  trees: readonly TreeSpec[],
  neighbours: readonly { ring: readonly PlanPoint[]; heightM: number; baseM: number }[],
): Occluders {
  const built = buildHouseGeometries(model);
  const turn = new Matrix4().makeRotationY((model.orientationDeg * Math.PI) / 180);
  const solid: number[] = [];
  for (const geometry of [built.walls, built.roof, built.floor]) {
    appendTriangles(solid, geometry, turn);
    geometry.dispose();
  }
  appendObject(solid, createBlockGroup(neighbours));
  const evergreen: number[] = [];
  const deciduous: number[] = [];
  appendObject(evergreen, createTreeGroup(trees.filter((tree) => tree.kind === 'evergreen')));
  appendObject(deciduous, createTreeGroup(trees.filter((tree) => tree.kind === 'deciduous')));
  return { solid: Float32Array.from(solid), evergreen: Float32Array.from(evergreen), deciduous: Float32Array.from(deciduous) };
}

/** Measuring points and normals for the worker, three floats each. */
export function cellSamples(grid: RoofGrid): { points: Float32Array; normals: Float32Array } {
  const points = new Float32Array(grid.cells.length * 3);
  const normals = new Float32Array(grid.cells.length * 3);
  grid.cells.forEach((cell, i) => {
    const normal = grid.faces[cell.face]?.normal ?? { x: 0, y: 1, z: 0 };
    points.set([cell.point.x, cell.point.y, cell.point.z], i * 3);
    normals.set([normal.x, normal.y, normal.z], i * 3);
  });
  return { points, normals };
}

/**
 * One coloured mesh per roof face, in the model's metres. Each square is painted by its share
 * of the ideal panel's sunlight; parts of the texture off the roof are left clear.
 */
export function createHeatOverlay(grid: RoofGrid, shares: Float32Array): Group {
  const group = new Group();
  group.name = 'solar-heatmap';
  const byFace = grid.faces.map(() => [] as number[]);
  grid.cells.forEach((cell, i) => byFace[cell.face]?.push(i));

  grid.faces.forEach((face, faceIndex) => {
    const width = face.cols * PIXELS_PER_CELL;
    const height = face.rows * PIXELS_PER_CELL;
    const pixels = new Uint8Array(width * height * 4);
    for (const i of byFace[faceIndex] ?? []) {
      const cell = grid.cells[i];
      if (cell === undefined) continue;
      const [r, g, b] = heatColor(shares[i] ?? 0);
      for (let y = 0; y < PIXELS_PER_CELL; y++) {
        for (let x = 0; x < PIXELS_PER_CELL; x++) {
          const edge = x === 0 || y === 0 || x === PIXELS_PER_CELL - 1 || y === PIXELS_PER_CELL - 1;
          const shade = edge ? 0.72 : 1;
          const at = ((cell.row * PIXELS_PER_CELL + y) * width + cell.col * PIXELS_PER_CELL + x) * 4;
          pixels[at] = r * shade;
          pixels[at + 1] = g * shade;
          pixels[at + 2] = b * shade;
          pixels[at + 3] = 255;
        }
      }
    }
    const texture = new DataTexture(pixels, width, height);
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;

    const count = face.triangles.length / 3;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = face.triangles[i * 3] ?? 0;
      const y = face.triangles[i * 3 + 1] ?? 0;
      const z = face.triangles[i * 3 + 2] ?? 0;
      positions[i * 3] = x + face.normal.x * OVERLAY_LIFT_M;
      positions[i * 3 + 1] = y + face.normal.y * OVERLAY_LIFT_M;
      positions[i * 3 + 2] = z + face.normal.z * OVERLAY_LIFT_M;
      const dx = x - face.origin.x;
      const dy = y - face.origin.y;
      const dz = z - face.origin.z;
      uvs[i * 2] = (dx * face.u.x + dy * face.u.y + dz * face.u.z) / face.cols;
      uvs[i * 2 + 1] = (dx * face.v.x + dy * face.v.y + dz * face.v.z) / face.rows;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    const material = new MeshBasicMaterial({ map: texture, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    const mesh = new Mesh(geometry, material);
    mesh.name = 'solar-heatmap-face';
    mesh.userData.heatFace = faceIndex;
    group.add(mesh);
  });
  return group;
}

const cellLookups = new WeakMap<RoofGrid, Map<string, number>>();

/** The square at a texture coordinate on one face's overlay, as an index into `grid.cells`. -1 is off the roof. */
export function cellAtUv(grid: RoofGrid, faceIndex: number, uv: { x: number; y: number }): number {
  const face = grid.faces[faceIndex];
  if (face === undefined) return -1;
  let lookup = cellLookups.get(grid);
  if (lookup === undefined) {
    lookup = new Map(grid.cells.map((cell, i) => [`${cell.face}:${cell.col}:${cell.row}`, i]));
    cellLookups.set(grid, lookup);
  }
  const col = Math.min(face.cols - 1, Math.max(0, Math.floor(uv.x * face.cols)));
  const row = Math.min(face.rows - 1, Math.max(0, Math.floor(uv.y * face.rows)));
  return lookup.get(`${faceIndex}:${col}:${row}`) ?? -1;
}

/** The four corners of a square, just above the overlay, for outlining it. Three floats each. */
export function cellCorners(grid: RoofGrid, index: number): Float32Array {
  const cell = grid.cells[index];
  const face = cell === undefined ? undefined : grid.faces[cell.face];
  if (cell === undefined || face === undefined) return new Float32Array(0);
  const lift = OVERLAY_LIFT_M * 2;
  const corners = [
    [cell.col, cell.row],
    [cell.col + 1, cell.row],
    [cell.col + 1, cell.row + 1],
    [cell.col, cell.row + 1],
  ];
  return Float32Array.from(
    corners.flatMap(([a = 0, b = 0]) => [
      face.origin.x + face.u.x * a * CELL_M + face.v.x * b * CELL_M + face.normal.x * lift,
      face.origin.y + face.u.y * a * CELL_M + face.v.y * b * CELL_M + face.normal.y * lift,
      face.origin.z + face.u.z * a * CELL_M + face.v.z * b * CELL_M + face.normal.z * lift,
    ]),
  );
}

export function disposeHeatOverlay(group: Group): void {
  group.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.geometry.dispose();
    const material = node.material as MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
  });
}

/** A modern panel's rating per square metre: about 21% of 1,000 W/m² of full sun. */
export const PANEL_KW_PER_M2 = 0.21;
/**
 * The share of a panel's rating that reaches the house over a year: heat, wiring, the inverter,
 * dust and reflection. 0.8 matches PVGIS's own estimates with its usual 14% system loss.
 */
export const PERFORMANCE_RATIO = 0.8;

/** Electricity a year from one square metre of panel getting this much sunlight. */
export function panelKwhPerM2(sunKwhPerM2: number): number {
  return sunKwhPerM2 * PANEL_KW_PER_M2 * PERFORMANCE_RATIO;
}

/** One roof side, or one building's whole roof, added up. */
export interface RoofTotal {
  areaM2: number;
  /** Area-weighted share of the ideal panel's sunlight. */
  meanShare: number;
  /** A year of sunlight on all of it, kWh, area included. */
  kwh: number;
  /** The part at or above `goodShare`. */
  goodM2: number;
  goodKwh: number;
}

/** Add up the squares of one roof side (`face`), or of every face of one building (`building`). */
export function roofTotal(
  grid: RoofGrid,
  kwhPerM2: Float32Array,
  idealKwhPerM2: number,
  which: { face: number } | { building: string },
  goodShare = 0.8,
): RoofTotal {
  let areaM2 = 0;
  let kwh = 0;
  let goodM2 = 0;
  let goodKwh = 0;
  grid.cells.forEach((cell, i) => {
    const inside = 'face' in which ? cell.face === which.face : grid.faces[cell.face]?.building === which.building;
    if (!inside) return;
    const sun = kwhPerM2[i] ?? 0;
    areaM2 += cell.areaM2;
    kwh += sun * cell.areaM2;
    if (idealKwhPerM2 > 0 && sun / idealKwhPerM2 >= goodShare) {
      goodM2 += cell.areaM2;
      goodKwh += sun * cell.areaM2;
    }
  });
  return { areaM2, meanShare: areaM2 > 0 && idealKwhPerM2 > 0 ? kwh / areaM2 / idealKwhPerM2 : 0, kwh, goodM2, goodKwh };
}

export interface HeatSummary {
  roofM2: number;
  /** Area-weighted share of the ideal panel's sunlight. */
  meanShare: number;
  /** Roof area getting at least this share. */
  goodM2: number;
  goodShare: number;
  /** A year of sunlight on the squares at or above `goodShare`, kWh, area included. */
  goodKwh: number;
  /** Sunlight lost to shade, as a share of what the same roof would get in the open. */
  shadeLoss: number;
  /** A year of clear-sky sunlight on the ideal panel, kWh/m². */
  idealKwhPerM2: number;
}

export function summarizeHeat(
  grid: RoofGrid,
  result: { kwhPerM2: Float32Array; openKwhPerM2: Float32Array },
  idealKwhPerM2: number,
  goodShare = 0.8,
): HeatSummary {
  let roofM2 = 0;
  let weighted = 0;
  let goodM2 = 0;
  let goodKwh = 0;
  let shaded = 0;
  let open = 0;
  grid.cells.forEach((cell, i) => {
    const kwh = result.kwhPerM2[i] ?? 0;
    const share = idealKwhPerM2 > 0 ? kwh / idealKwhPerM2 : 0;
    roofM2 += cell.areaM2;
    weighted += share * cell.areaM2;
    if (share >= goodShare) {
      goodM2 += cell.areaM2;
      goodKwh += kwh * cell.areaM2;
    }
    shaded += kwh * cell.areaM2;
    open += (result.openKwhPerM2[i] ?? 0) * cell.areaM2;
  });
  return {
    roofM2,
    meanShare: roofM2 > 0 ? weighted / roofM2 : 0,
    goodM2,
    goodShare,
    goodKwh,
    shadeLoss: open > 0 ? Math.max(0, 1 - shaded / open) : 0,
    idealKwhPerM2,
  };
}

function appendObject(out: number[], root: Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (node instanceof Mesh) appendTriangles(out, node.geometry as BufferGeometry, node.matrixWorld);
  });
  root.traverse((node) => {
    if (node instanceof Mesh) node.geometry.dispose();
  });
}

function appendTriangles(out: number[], geometry: BufferGeometry, matrix: Matrix4): void {
  const position = geometry.getAttribute('position');
  if (position === undefined) return;
  const index = geometry.getIndex();
  const total = index === null ? position.count : index.count;
  const point = new Vector3();
  for (let i = 0; i < total; i++) {
    const vertex = index === null ? i : index.getX(i);
    point.fromBufferAttribute(position, vertex).applyMatrix4(matrix);
    out.push(point.x, point.y, point.z);
  }
}
