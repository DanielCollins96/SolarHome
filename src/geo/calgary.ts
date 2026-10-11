import type { GeographicBuilding } from '../house/assemble.ts';
import { pointInRing } from '../house/planGeometry.ts';
import { projectToLocal, type LngLat } from './projection.ts';

/**
 * The City of Calgary's 3D Buildings dataset: every building outline with its ground and rooftop
 * elevation, measured by aerial LiDAR in 2018 and 2020. Free, keyless, and open to browser calls.
 * https://data.calgary.ca/Base-Maps/3D-Buildings-Citywide/cchr-krqg
 */
const CITY_BUILDINGS_URL = 'https://data.calgary.ca/resource/cchr-krqg.json';

/** A box around the city limits. Outside it, the city has nothing to add. */
const CALGARY_BOUNDS = { south: 50.84, north: 51.22, west: -114.32, east: -113.85 };

/** Credited on the height note, as the city's open-data licence asks. */
export const CALGARY_HEIGHT_SOURCE = 'City of Calgary LiDAR';

interface CityBuildingRow {
  polygon?: { type: string; coordinates: number[][][] };
  grd_elev_min_z?: string;
  rooftop_elev_z?: string;
}

export function inCalgary(point: LngLat): boolean {
  const { south, north, west, east } = CALGARY_BOUNDS;
  return point.latitude >= south && point.latitude <= north && point.longitude >= west && point.longitude <= east;
}

/** True when some part has no OSM height or level count, so the model would fall back to a guess. */
export function lacksHeight(building: GeographicBuilding): boolean {
  return building.parts.some((part) => {
    const tags = part.tags ?? building.tags;
    return tags.height === undefined && tags['building:levels'] === undefined;
  });
}

/**
 * Fill in the city's measured height on each part that OpenStreetMap leaves without one. The
 * rooftop elevation is the highest point of the roof, which is what the OSM `height` tag means.
 * Returns the building unchanged when it is outside Calgary or the city has no match.
 */
export async function withCalgaryHeights(building: GeographicBuilding, fetcher: typeof fetch): Promise<GeographicBuilding> {
  const corners = building.parts.flatMap((part) => part.outer);
  const first = corners[0];
  if (first === undefined || !inCalgary(first) || !lacksHeight(building)) return building;
  const rows = await cityBuildingsAround(corners, fetcher);
  const footprints = rows.flatMap((row) => {
    const ring = row.polygon?.coordinates[0];
    const ground = Number(row.grd_elev_min_z);
    const top = Number(row.rooftop_elev_z);
    if (ring === undefined || ring.length < 4 || !Number.isFinite(ground) || !Number.isFinite(top) || top <= ground) return [];
    return [{ ring: ring.map(([longitude = 0, latitude = 0]) => ({ longitude, latitude })), heightM: top - ground }];
  });
  let changed = false;
  const parts = building.parts.map((part) => {
    const tags = part.tags ?? building.tags;
    if (tags.height !== undefined || tags['building:levels'] !== undefined) return part;
    const match = bestMatch(part.outer, footprints);
    if (match === undefined) return part;
    changed = true;
    return { ...part, tags: { ...tags, height: match.heightM.toFixed(1), 'height:source': CALGARY_HEIGHT_SOURCE } };
  });
  return changed ? { ...building, parts } : building;
}

async function cityBuildingsAround(corners: readonly LngLat[], fetcher: typeof fetch): Promise<CityBuildingRow[]> {
  const south = Math.min(...corners.map((point) => point.latitude));
  const north = Math.max(...corners.map((point) => point.latitude));
  const west = Math.min(...corners.map((point) => point.longitude));
  const east = Math.max(...corners.map((point) => point.longitude));
  const url = new URL(CITY_BUILDINGS_URL);
  url.searchParams.set('$select', 'polygon,grd_elev_min_z,rooftop_elev_z');
  // `within_box` would drop an outline that pokes out of the box, so ask for any that touch it.
  const box = [`${west} ${south}`, `${east} ${south}`, `${east} ${north}`, `${west} ${north}`, `${west} ${south}`].join(', ');
  url.searchParams.set('$where', `intersects(polygon, 'POLYGON((${box}))')`);
  url.searchParams.set('$limit', '2000');
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The City of Calgary answered ${response.status}.`);
  return (await response.json()) as CityBuildingRow[];
}

/**
 * The city outline that covers most of this part: the share of the part's corners and centre
 * inside it. Outlines are traced separately by the city and by OSM, so they never match exactly.
 */
function bestMatch(outer: readonly LngLat[], footprints: readonly { ring: LngLat[]; heightM: number }[]): { heightM: number } | undefined {
  const centre = {
    latitude: outer.reduce((sum, point) => sum + point.latitude, 0) / outer.length,
    longitude: outer.reduce((sum, point) => sum + point.longitude, 0) / outer.length,
  };
  const probes = [centre, ...outer];
  let best: { heightM: number; hits: number } | undefined;
  for (const footprint of footprints) {
    const hits = probes.filter((point) => contains(footprint.ring, point)).length;
    // The centre, or at least half the corners, keeps a neighbour that only shares a wall from
    // lending its height.
    if (!contains(footprint.ring, centre) && hits * 2 < probes.length) continue;
    if (best === undefined || hits > best.hits || (hits === best.hits && footprint.heightM > best.heightM)) {
      best = { heightM: footprint.heightM, hits };
    }
  }
  return best;
}

function contains(ring: readonly LngLat[], point: LngLat): boolean {
  return pointInRing({ east: 0, north: 0 }, ring.map((vertex) => projectToLocal(vertex, point)));
}

/**
 * The City of Calgary's 2024 tree canopy: outlines of all tree cover 2 m and taller, public and
 * private, from aerial imagery and LiDAR. It gives the crown's shape but not its height.
 * https://data.calgary.ca/dataset/Tree-Canopy-Raw-Data-2024/536h-ahuc
 */
const CITY_CANOPY_URL = 'https://data.calgary.ca/resource/536h-ahuc.json';
const MAX_CANOPY_PIECES = 2000;

interface CanopyRow {
  multipolygon?: { type: string; coordinates: number[][][][] };
}

/** Outer rings of the tree canopy touching a box. Holes in a crown are too small to matter for shade. */
export async function loadCalgaryCanopy(
  box: { south: number; west: number; north: number; east: number },
  fetcher: typeof fetch,
): Promise<LngLat[][]> {
  const { south, west, north, east } = box;
  const url = new URL(CITY_CANOPY_URL);
  const ring = [`${west} ${south}`, `${east} ${south}`, `${east} ${north}`, `${west} ${north}`, `${west} ${south}`].join(', ');
  url.searchParams.set('$where', `intersects(multipolygon, 'POLYGON((${ring}))')`);
  url.searchParams.set('$limit', String(MAX_CANOPY_PIECES));
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The City of Calgary answered ${response.status}.`);
  const rows = (await response.json()) as CanopyRow[];
  return rows.flatMap((row) =>
    (row.multipolygon?.coordinates ?? []).flatMap((polygon) => {
      const outer = polygon[0];
      if (outer === undefined || outer.length < 4) return [];
      return [outer.map(([longitude = 0, latitude = 0]) => ({ longitude, latitude }))];
    }),
  );
}

/**
 * The City of Calgary's public tree inventory: every tree on city land, with whether it is
 * evergreen or deciduous and its trunk width. Trees on private land are only in the canopy.
 * https://data.calgary.ca/Environment/Public-Trees/tfs4-3wwa
 */
const CITY_TREES_URL = 'https://data.calgary.ca/resource/tfs4-3wwa.json';

export interface ListedTree {
  at: LngLat;
  evergreen: boolean;
  /** Crown width estimated from the trunk, metres. */
  widthM: number;
}

interface TreeRow {
  point?: { type: string; coordinates: number[] };
  asset_subtype?: string;
  dbh_cm?: string;
  mature_size?: string;
}

export async function loadCalgaryTrees(
  box: { south: number; west: number; north: number; east: number },
  fetcher: typeof fetch,
): Promise<ListedTree[]> {
  const url = new URL(CITY_TREES_URL);
  url.searchParams.set('$select', 'point,asset_subtype,dbh_cm,mature_size');
  url.searchParams.set('$where', `within_box(point, ${box.north}, ${box.west}, ${box.south}, ${box.east})`);
  url.searchParams.set('$limit', String(MAX_CANOPY_PIECES));
  const response = await fetcher(url.toString(), { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`The City of Calgary answered ${response.status}.`);
  const rows = (await response.json()) as TreeRow[];
  return rows.flatMap((row) => {
    const [longitude, latitude] = row.point?.coordinates ?? [];
    // Shrubs are in the inventory too, but cast no shade worth drawing.
    if (longitude === undefined || latitude === undefined || row.mature_size === 'SHRUB') return [];
    const trunkCm = Number(row.dbh_cm);
    // Crown width grows with the trunk: about 4.5 m at 20 cm, 12 m at 70 cm.
    const widthM = Number.isFinite(trunkCm) && trunkCm > 0 ? Math.min(14, Math.max(1.5, 0.15 * trunkCm + 1.5)) : 3;
    return [{ at: { longitude, latitude }, evergreen: row.asset_subtype === 'Evergreen', widthM }];
  });
}
