import { localToLngLat, projectToLocal, type LngLat } from '../geo/projection.ts';
import { pointInRing } from '../house/planGeometry.ts';
import type { HouseModel } from '../house/houseModel.ts';
import type { RoofGrid } from './roofCells.ts';

/**
 * Something that shades the roofs, in map coordinates: a selected building, a map block or a tree.
 * Its key changes whenever its shape, height or kind does.
 */
export interface Caster {
  key: string;
  /** The selected building's id, as on its roof faces. Null for a map block or a tree. */
  building: string | null;
  rings: LngLat[][];
  /** A selected building's heights and roofs, without its outline. */
  shape?: string;
}

/**
 * Map blocks are only drawn this far around the selection, so shade from farther away was never
 * counted for a roof. A change farther than this from a building leaves its squares as they were.
 */
export const SHADE_REACH_M = 60;

/** Squares already traced, with what shaded them then. */
export interface HeatCache {
  /** The sky they were traced under: the place and the year. */
  sky: string;
  casters: Caster[];
  /** Selected buildings seen so far, so a map block that stood for one of them is known later too. */
  selected: Caster[];
  /** Where the squares are measured from. */
  origin: LngLat;
  /** Sunlight per square, shade included and in the open. */
  cells: SavedCell[];
  /** The squares by the metre-sized box each sits in, to find one near a point. */
  index: Map<string, number[]>;
}

interface SavedCell {
  building: string;
  /** Metres east, up and south of the cache's origin. */
  x: number;
  y: number;
  z: number;
  normal: { x: number; y: number; z: number };
  kwh: number;
  open: number;
}

/**
 * How far a square may have moved and still be the same one. The roof's corners are stored as
 * single-precision numbers measured from the model's centre, so when the centre moves the grid
 * can land a few tenths of a metre to one side. A fresh trace would land there too.
 */
const SAME_CELL_M = 0.75;
/** Faces within about 2.5° of each other face the same way. */
const SAME_FACING = 0.999;

/** Keeps the latest selected buildings, enough for a session of clicking around one place. */
const SELECTED_KEPT = 200;

/** The selected buildings, one caster each, in map coordinates. */
export function buildingCasters(model: HouseModel): Caster[] {
  const angle = (model.orientationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const byBuilding = new Map<string, HouseModel['parts']>();
  for (const part of model.parts) {
    const id = part.sourceId ?? '';
    byBuilding.set(id, [...(byBuilding.get(id) ?? []), part]);
  }
  return [...byBuilding].map(([building, parts]) => {
    // Plan metres turned to true east and north, as the house group is turned in the scene.
    const rings = parts.map((part) =>
      part.footprint.map((point) => localToLngLat({ east: point.east * cos - point.north * sin, north: point.east * sin + point.north * cos }, model.origin)),
    );
    // Holes are in metres from the model's centre, which moves as buildings are added, so only their count goes in.
    // A ridge running either way is the same roof; only a shed's slope has a downhill side.
    const shape = parts.map((part) => ({
      ...part,
      footprint: undefined,
      holes: part.holes.length,
      id: undefined,
      sourceId: undefined,
      roof: { ...part.roof, directionDeg: part.roof.type === 'shed' ? part.roof.directionDeg : part.roof.directionDeg % 180 },
    }));
    // Rounded: a roof's direction is worked out from the outline and differs in the last digits from one centre to another.
    const shapeText = JSON.stringify(shape, (_key, value: unknown) => (typeof value === 'number' ? Number(value.toFixed(4)) : value));
    return { key: `building:${building}:${JSON.stringify(rings.map((ring) => ring.map(roundPoint)))}:${shapeText}`, building, rings, shape: shapeText };
  });
}

/**
 * The map's blocks, one caster per map building. Each tile holds its own clipped copy of a building,
 * and which copy is drawn can change as tiles load, so a block is known by its map id and height.
 */
export function blockCasters(blocks: readonly { key: string; ring: LngLat[]; heightM: number; baseM: number }[]): Caster[] {
  const byId = new Map<string, Caster>();
  for (const block of blocks) {
    // `source:id:piece`: the pieces of one map building share a caster.
    const id = block.key.slice(0, Math.max(0, block.key.lastIndexOf(':')));
    const key = `block:${id}:${block.heightM}:${block.baseM}`;
    const caster = byId.get(key);
    if (caster === undefined) byId.set(key, { key, building: null, rings: [block.ring] });
    else caster.rings.push(block.ring);
  }
  return [...byId.values()];
}

/**
 * The saved sunlight for each square of the grid, or null where there is none: a new roof, one
 * near a change, or a roof that moved. `stale` names the buildings whose squares do not stand.
 */
export function savedCells(cache: HeatCache | null, grid: RoofGrid, origin: LngLat, stale: ReadonlySet<string>): ({ kwh: number; open: number } | null)[] {
  if (cache === null) return grid.cells.map(() => null);
  const shift = projectToLocal(origin, cache.origin);
  return grid.cells.map((cell) => {
    const face = grid.faces[cell.face];
    if (face === undefined || stale.has(face.building)) return null;
    const x = cell.point.x + shift.east;
    const y = cell.point.y;
    const z = cell.point.z - shift.north;
    let best: SavedCell | null = null;
    let bestGap = SAME_CELL_M;
    for (const key of nearbyBoxes(x, y, z)) {
      for (const index of cache.index.get(key) ?? []) {
        const saved = cache.cells[index];
        if (saved === undefined || saved.building !== face.building) continue;
        const facing = saved.normal.x * face.normal.x + saved.normal.y * face.normal.y + saved.normal.z * face.normal.z;
        if (facing < SAME_FACING) continue;
        const gap = Math.hypot(saved.x - x, saved.y - y, saved.z - z);
        if (gap > bestGap) continue;
        best = saved;
        bestGap = gap;
      }
    }
    return best === null ? null : { kwh: best.kwh, open: best.open };
  });
}

function boxKey(x: number, y: number, z: number): string {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

function* nearbyBoxes(x: number, y: number, z: number): Generator<string> {
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) yield boxKey(x + i, y + j, z + k);
}

/**
 * The selected buildings whose traced squares no longer hold, because something within reach of
 * them that casts shade changed. A selected building and the map block it replaces are the same
 * shadow, so selecting a neighbour, or letting one go, changes nothing for the rest.
 */
export function staleBuildings(cache: HeatCache, casters: readonly Caster[]): Set<string> {
  const before = new Set(cache.casters.map((caster) => caster.key));
  const after = new Set(casters.map((caster) => caster.key));
  const removed = cache.casters.filter((caster) => !after.has(caster.key));
  const added = casters.filter((caster) => !before.has(caster.key));
  const selected = [...cache.selected, ...casters.filter((caster) => caster.building !== null)];
  const changed = [...removed, ...added].filter((caster) => {
    if (caster.building !== null) {
      // The same building with another shape or height was edited. Otherwise it was only
      // selected or let go, and the map's block of it shaded the others before and after.
      const twin = (removed.includes(caster) ? added : removed).find((other) => other.building === caster.building);
      return twin !== undefined && !sameBuilding(twin, caster);
    }
    // A map block standing for a selected building, which comes and goes as it is selected.
    const middle = centroid(caster.rings[0] ?? []);
    return !selected.some((building) => building.rings.some((ring) => ringHolds(ring, middle)));
  });
  const stale = new Set<string>();
  for (const building of casters) {
    if (building.building === null) continue;
    // Blocks and trees are counted by their centre, as the map chooses which blocks to draw.
    const near = (caster: Caster) => boxGapM(caster.building === null ? [[centroid(caster.rings.flat())]] : caster.rings, building.rings) <= SHADE_REACH_M;
    if (changed.some(near)) stale.add(building.building);
  }
  return stale;
}

/** The cache after a trace: these squares, under these casters. */
export function nextCache(
  previous: HeatCache | null,
  sky: string,
  casters: Caster[],
  grid: RoofGrid,
  origin: LngLat,
  kwh: Float32Array,
  open: Float32Array,
): HeatCache {
  const cells: SavedCell[] = [];
  const index = new Map<string, number[]>();
  grid.cells.forEach((cell, i) => {
    const face = grid.faces[cell.face];
    if (face === undefined) return;
    const { x, y, z } = cell.point;
    const key = boxKey(x, y, z);
    index.set(key, [...(index.get(key) ?? []), cells.length]);
    cells.push({ building: face.building, x, y, z, normal: face.normal, kwh: kwh[i] ?? 0, open: open[i] ?? 0 });
  });
  const seen = new Map((previous?.sky === sky ? previous.selected : []).map((caster) => [caster.key, caster]));
  for (const caster of casters) if (caster.building !== null) seen.set(caster.key, caster);
  return { sky, casters, selected: [...seen.values()].slice(-SELECTED_KEPT), origin, cells, index };
}

/** The same outline and shape, give or take the rounding from a model centred somewhere else. */
function sameBuilding(a: Caster, b: Caster): boolean {
  if (a.shape !== b.shape || a.rings.length !== b.rings.length) return false;
  return a.rings.every((ring, i) => {
    const other = b.rings[i];
    if (other === undefined || other.length !== ring.length) return false;
    return ring.every((point, j) => {
      const twin = other[j];
      return twin !== undefined && Math.abs(point.latitude - twin.latitude) < 1e-7 && Math.abs(point.longitude - twin.longitude) < 1e-7;
    });
  });
}

function roundPoint(point: LngLat): [number, number] {
  return [Number(point.longitude.toFixed(7)), Number(point.latitude.toFixed(7))];
}

function centroid(ring: readonly LngLat[]): LngLat {
  if (ring.length === 0) return { latitude: 0, longitude: 0 };
  const latitude = ring.reduce((sum, point) => sum + point.latitude, 0) / ring.length;
  const longitude = ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length;
  return { latitude, longitude };
}

function ringHolds(ring: readonly LngLat[], point: LngLat): boolean {
  if (ring.length < 3) return false;
  return pointInRing(
    { east: point.longitude, north: point.latitude },
    ring.map((vertex) => ({ east: vertex.longitude, north: vertex.latitude })),
  );
}

/** Metres between the boxes around two sets of rings, zero when they overlap. */
function boxGapM(a: readonly LngLat[][], b: readonly LngLat[][]): number {
  const one = box(a);
  const two = box(b);
  if (one === null || two === null) return Infinity;
  const metresPerDegree = 111_320;
  const cos = Math.cos((((one.south + one.north) / 2) * Math.PI) / 180);
  const east = Math.max(0, one.west - two.east, two.west - one.east) * metresPerDegree * cos;
  const north = Math.max(0, one.south - two.north, two.south - one.north) * metresPerDegree;
  return Math.hypot(east, north);
}

function box(rings: readonly LngLat[][]): { west: number; east: number; south: number; north: number } | null {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      west = Math.min(west, point.longitude);
      east = Math.max(east, point.longitude);
      south = Math.min(south, point.latitude);
      north = Math.max(north, point.latitude);
    }
  }
  return Number.isFinite(west) ? { west, east, south, north } : null;
}
