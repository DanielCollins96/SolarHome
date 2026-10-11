import type { LookupCache } from './cache.ts';
import { GeoFailure, type GeocodeHit } from './geocode.ts';
import { projectToLocal } from './projection.ts';
import type { GeographicBuilding, GeographicRing } from '../house/assemble.ts';
import { parseLengthMeters } from '../house/heightEstimate.ts';
import { pointInRing } from '../house/planGeometry.ts';
import type { LngLat } from './projection.ts';
import { sendRequest } from './request.ts';
import { sameOrigin } from './sameOrigin.ts';

export interface OverpassDeps {
  fetch: typeof fetch;
  cache: LookupCache;
  signal?: AbortSignal;
  /** Waits before each retry when Overpass is busy. The public server often answers 504 for a few seconds. */
  retryDelaysMs?: readonly number[];
}

const RETRY_DELAYS_MS = [2_000, 5_000];

interface OsmPoint {
  lat: number;
  lon: number;
}

/** An OSM element as Overpass returns it with `out geom`. Main API answers are converted to this shape. */
interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  /** Main API ways list node ids instead of geometry. */
  nodes?: number[];
  lat?: number;
  lon?: number;
  members?: { type: string; ref?: number; role?: string; geometry?: OsmPoint[] }[];
}

/** Where a lookup goes: an Overpass query, or a path on the main OpenStreetMap API. */
type Source = { overpass: string } | { osm: string };

const ENDPOINT = sameOrigin('/api/overpass');
const AROUND_M = 45;
/** Half-width of the map box read around a click, so the walls of a large building are inside it. */
const MIN_POINT_REACH_M = 60;
const MAX_POINT_REACH_M = 300;

/**
 * Load the building for a geocoder hit. Single buildings come from the main OpenStreetMap API,
 * which answers reliably; the public Overpass server is often busy for minutes at a time.
 */
export async function loadBuilding(hit: GeocodeHit, deps: OverpassDeps): Promise<GeographicBuilding> {
  if (hit.osmType === 'way' || hit.osmType === 'relation') {
    const building = await loadOsmElement(hit.osmType, hit.osmId, hit.label, deps);
    if (building !== null) return building;
  }
  const around = await fetchElements({ overpass: aroundQuery(hit.latitude, hit.longitude) }, aroundKey(hit), deps);
  const chosen = chooseBuilding(around, hit.latitude, hit.longitude, hit.label);
  if (chosen === null) {
    throw new GeoFailure('not-found', 'No building footprint was found there. Search a street address, not only a city.');
  }
  return chosen;
}

/**
 * A way or relation by id, as a whole building. A search can land on the outline of a building
 * drawn in parts, like the CN Tower; the parts are the building, and the outline alone is a solid column.
 */
async function loadOsmElement(
  osmType: 'way' | 'relation',
  osmId: number,
  label: string,
  deps: OverpassDeps,
): Promise<GeographicBuilding | null> {
  const parents = await fetchElements({ osm: `/${osmType}/${osmId}/relations.json` }, `osm:${osmType}:${osmId}:relations`, deps);
  const parent = parents.find((element) => element.type === 'relation' && element.tags?.type === 'building');
  if (parent !== undefined) {
    const building = partsBuildingIn(await fetchRelation(parent.id, deps));
    if (building !== null) return building;
  }
  const path = osmType === 'way' ? `/way/${osmId}/full.json` : `/relation/${osmId}/full.json`;
  const own = await fetchElements({ osm: path }, `osm:${osmType}:${osmId}:full`, deps);
  const whole = partsBuildingIn(own);
  if (whole !== null) return whole;
  const building = buildingFromElements(own.filter((element) => element.type === osmType && element.id === osmId), label);
  return building === null ? null : withLooseParts(building, deps);
}

function fetchRelation(id: number, deps: OverpassDeps): Promise<OverpassElement[]> {
  return fetchElements({ osm: `/relation/${id}/full.json` }, `osm:relation:${id}:full`, deps);
}

/**
 * The building containing a point: its building relation when it has one, else the smallest
 * building outline around the point. Reads the main API's map data for a box around the point.
 */
async function loadOsmBuildingAt(
  latitude: number,
  longitude: number,
  reachM: number,
  deps: OverpassDeps,
  probes: readonly LngLat[] = [],
  nearby: readonly LngLat[] = [],
): Promise<GeographicBuilding | null> {
  const reach = Math.min(MAX_POINT_REACH_M, Math.max(MIN_POINT_REACH_M, Math.ceil(reachM)));
  const dLat = reach / 111_320;
  const dLon = reach / (111_320 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.01));
  const box = [longitude - dLon, latitude - dLat, longitude + dLon, latitude + dLat].map((value) => value.toFixed(6)).join(',');
  const area = await fetchElements({ osm: `/map.json?bbox=${box}` }, `osm:map:${box}`, deps);
  // The point, plus any extra points known to be on the building, such as the corners of the
  // map piece that was clicked. A piece at the edge of a landmark can have its centre just outside.
  const points = [{ latitude, longitude }, ...probes];
  const inside = (footprint: GeographicBuilding, list: readonly LngLat[]) =>
    list.filter((point) => buildingContains(footprint, point.latitude, point.longitude)).length;
  // Relations in a map box are listed without the members outside it, so each is loaded whole.
  const relations = area
    .filter((element) => element.type === 'relation' && (element.tags?.type === 'building' || element.tags?.building !== undefined))
    .slice(0, 4);
  const candidates: { building: GeographicBuilding; hits: number; nearHits: number; area: number; relation: boolean }[] = [];
  const consider = (building: GeographicBuilding, footprint: GeographicBuilding, relation: boolean) => {
    const hits = inside(footprint, points);
    if (hits > 0) candidates.push({ building, hits, nearHits: inside(footprint, nearby), area: buildingArea(footprint), relation });
  };
  for (const relation of relations) {
    const full = await fetchRelation(relation.id, deps);
    const element = full.find((item) => item.type === 'relation' && item.id === relation.id);
    if (element === undefined) continue;
    const ways = waysOf(full);
    const building = element.tags?.type === 'building' ? relationBuilding(element, ways) : toBuildings(element, element.tags?.name ?? 'Building')[0] ?? null;
    const footprint = element.tags?.type === 'building' ? relationBuilding(element, ways, true) : building;
    if (building !== null && footprint !== null) consider(building, footprint, true);
  }
  for (const element of area) {
    // Parts are gathered from the building's outline afterwards. On their own, a tower's
    // antenna would win as the smallest outline around a click at its centre.
    if (element.type !== 'way' || element.tags?.building === undefined) continue;
    for (const building of toBuildings(element, element.tags?.name ?? 'Building')) consider(building, building, false);
  }
  // Most of the clicked points inside wins. Points on touching pieces only break a tie: those can
  // belong to the building next door, like a rotunda against a courthouse. Then a building relation
  // beats its own outline, and the smaller one wins.
  candidates.sort(
    (a, b) => b.hits - a.hits || b.nearHits - a.nearHits || Number(b.relation) - Number(a.relation) || a.area - b.area,
  );
  const chosen = candidates[0];
  if (chosen === undefined) return null;
  return chosen.relation ? chosen.building : withLooseParts(chosen.building, deps);
}

/** An outline wider than this is not searched for loose parts: the map read would be too large. */
const MAX_LOOSE_PARTS_SPAN_M = 600;

/**
 * Building parts drawn inside an outline belong to it even without a building relation, by the
 * OSM 3D convention. The Eiffel Tower is mapped this way: a 330 m outline of its four legs, and
 * some twenty separate parts for the legs, floors, and antenna. When parts are found, they are
 * the building and the outline is left out.
 */
async function withLooseParts(building: GeographicBuilding, deps: OverpassDeps): Promise<GeographicBuilding> {
  const outline = building.parts[0]?.outer;
  if (building.parts.length !== 1 || outline === undefined || outline.length < 3) return building;
  if (isPart(building.tags['building:part'])) return building;
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  for (const point of outline) {
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
  }
  const span = Math.max(metersNorth(north - south), metersEast(east - west, (south + north) / 2));
  if (span > MAX_LOOSE_PARTS_SPAN_M) return building;
  const box = [west, south, east, north].map((value) => value.toFixed(6)).join(',');
  let elements: OverpassElement[];
  try {
    elements = await fetchElements({ osm: `/map.json?bbox=${box}` }, `osm:map:${box}`, deps);
  } catch {
    // The outline alone is still a usable building.
    return building;
  }
  const parts: GeographicRing[] = [];
  for (const element of elements) {
    if (element.type !== 'way' && element.type !== 'relation') continue;
    if (!isPart(element.tags?.['building:part'])) continue;
    for (const piece of toBuildings(element, 'Part')) {
      for (const ring of piece.parts) {
        if (insideOutline(ring.outer, outline)) parts.push({ ...ring, tags: piece.tags });
      }
    }
  }
  if (parts.length === 0) return building;
  // Parts that stop well short of the outline's height are an unfinished mapping, like the
  // Calgary Tower: a 191 m outline with only its 9 m base drawn as a part. Keep the outline then.
  const outlineTop = tagHeight(building.tags);
  const partsTop = Math.max(0, ...parts.map((part) => tagHeight(part.tags ?? {}) ?? 0));
  if (outlineTop !== undefined && partsTop < outlineTop * 0.8) {
    const own = building.parts[0];
    if (own !== undefined) return { ...building, parts: [{ ...own, tags: building.tags }, ...parts] };
  }
  return { ...building, parts };
}

/** Height to the top from OSM tags: `height`, else 3 m per level. */
function tagHeight(tags: Record<string, string>): number | undefined {
  const height = parseLengthMeters(tags.height);
  if (height !== undefined) return height;
  const levels = Number(tags['building:levels']);
  return Number.isFinite(levels) && levels > 0 ? levels * 3 : undefined;
}

/**
 * A part belongs to the outline when its centre is inside, or most of its corners are. A sloped
 * leg that arches over open ground, like the Eiffel Tower's lowest stage, has its centre in the arch.
 */
function insideOutline(ring: LngLat[], outline: LngLat[]): boolean {
  const center = ringCenter(ring);
  if (center !== null && ringContains(outline, center)) return true;
  const inside = ring.filter((point) => ringContains(outline, point)).length;
  return inside * 2 > ring.length;
}

function ringCenter(ring: readonly LngLat[]): LngLat | null {
  if (ring.length === 0) return null;
  return {
    latitude: ring.reduce((sum, point) => sum + point.latitude, 0) / ring.length,
    longitude: ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length,
  };
}

function waysOf(elements: OverpassElement[]): Map<number, OverpassElement> {
  const ways = new Map<number, OverpassElement>();
  for (const element of elements) {
    if (element.type === 'way') ways.set(element.id, element);
  }
  return ways;
}

export function buildingContains(building: GeographicBuilding, latitude: number, longitude: number): boolean {
  return building.parts.some((part) => {
    const local = part.outer.map((point) => projectToLocal(point, { latitude, longitude }));
    return pointInRing({ east: 0, north: 0 }, local);
  });
}

export function buildingFromElements(elements: OverpassElement[], label: string): GeographicBuilding | null {
  const buildings = elements.flatMap((element) => toBuildings(element, label));
  return buildings[0] ?? null;
}

export function chooseBuilding(
  elements: OverpassElement[],
  latitude: number,
  longitude: number,
  label: string,
): GeographicBuilding | null {
  const buildings = elements.flatMap((element) => toBuildings(element, label));
  let best: { building: GeographicBuilding; area: number } | null = null;
  let nearest: { building: GeographicBuilding; distance: number } | null = null;
  for (const building of buildings) {
    const ring = building.parts[0];
    if (ring === undefined) continue;
    const local = ring.outer.map((point) => projectToLocal(point, { latitude, longitude }));
    const area = Math.abs(ringArea(local));
    if (pointInRing({ east: 0, north: 0 }, local)) {
      if (best === null || area < best.area) best = { building, area };
    }
    const distance = distanceToRing(local);
    if (nearest === null || distance < nearest.distance) nearest = { building, distance };
  }
  if (best !== null) return best.building;
  if (nearest !== null && nearest.distance <= AROUND_M) return nearest.building;
  return null;
}

/**
 * The building relation that contains this point, including every outline and part.
 * A single way is used when the point is not inside a building relation.
 * `wayReachM` is how far the building's walls may be from the point, so a large building drawn
 * as one way, like a pyramid, is still found from a click near its middle.
 */
export async function loadWholeBuilding(
  latitude: number,
  longitude: number,
  deps: OverpassDeps,
  wayReachM = 0,
  probes: readonly LngLat[] = [],
  nearby: readonly LngLat[] = [],
): Promise<GeographicBuilding> {
  const building = await loadOsmBuildingAt(latitude, longitude, wayReachM, deps, probes, nearby);
  if (building === null) {
    throw new GeoFailure('not-found', 'No building footprint was found at that place.');
  }
  return building;
}

/** Pick the containing building relation, or the containing way when there is no relation. */
export function wholeBuildingFromElements(
  elements: OverpassElement[],
  latitude: number,
  longitude: number,
): GeographicBuilding | null {
  const ways = waysOf(elements);
  let best: { building: GeographicBuilding; area: number } | null = null;
  for (const element of elements) {
    if (element.type !== 'relation' || element.tags?.type !== 'building') continue;
    const building = relationBuilding(element, ways);
    const footprint = relationBuilding(element, ways, true);
    if (building === null || footprint === null || !buildingContains(footprint, latitude, longitude)) continue;
    const area = buildingArea(building);
    if (best === null || area < best.area) best = { building, area };
  }
  if (best !== null) return best.building;
  return chooseBuilding(elements, latitude, longitude, 'Building');
}

/**
 * The relation's parts. Its `outline` member is the 2D footprint for maps that cannot draw
 * parts, so it is left out when parts exist (the CN Tower's would be a 553 m column), unless
 * it is tagged as a part itself, like Toronto City Hall's podium, or `withOutline` asks for
 * the ground footprint.
 */
function relationBuilding(
  relation: OverpassElement,
  ways: Map<number, OverpassElement>,
  withOutline = false,
): GeographicBuilding | null {
  const members = relation.members ?? [];
  const hasParts = members.some((member) => member.role === 'part');
  const parts: GeographicRing[] = [];
  for (const member of members) {
    if (member.role === 'inner' || member.type !== 'way' || member.ref === undefined) continue;
    const way = ways.get(member.ref);
    const outlineOnly = member.role === 'outline' && hasParts && !isPart(way?.tags?.['building:part']);
    if (outlineOnly && !withOutline) continue;
    const ring = closedRing(way?.geometry ?? member.geometry);
    if (ring === null) continue;
    parts.push({ outer: ring, holes: [], tags: way?.tags ?? {} });
  }
  if (parts.length === 0) return null;
  return {
    id: `relation/${relation.id}`,
    // Some relations, like the Burj Khalifa's, leave the name on the outline.
    label: relation.tags?.name ?? outlineName(relation, ways) ?? 'Building',
    tags: relation.tags ?? {},
    parts,
    provenance: { source: 'osm', confidence: 0.8, note: `relation ${relation.id}` },
  };
}

function outlineName(relation: OverpassElement, ways: Map<number, OverpassElement>): string | undefined {
  const outline = relation.members?.find((member) => member.role === 'outline' && member.ref !== undefined);
  return outline?.ref === undefined ? undefined : ways.get(outline.ref)?.tags?.name;
}

function isPart(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== 'no';
}

async function fetchElements(source: Source, cacheKey: string, deps: OverpassDeps): Promise<OverpassElement[]> {
  // The cache only saves a trip. A broken or full browser store must not fail the lookup.
  const cached = await deps.cache.get(cacheKey).catch(() => undefined);
  if (cached !== undefined) return parseElements(cached);
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestElements(source, cacheKey, deps);
    } catch (error) {
      const delay = delays[attempt];
      const busy = error instanceof GeoFailure && error.kind === 'timeout' && deps.signal?.aborted !== true;
      if (!busy || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function requestElements(source: Source, cacheKey: string, deps: OverpassDeps): Promise<OverpassElement[]> {
  let response: Response;
  try {
    response =
      'overpass' in source
        ? await sendRequest(deps.fetch, ENDPOINT, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ data: source.overpass }),
            signal: deps.signal,
          })
        : await sendRequest(deps.fetch, sameOrigin(`/api/osm${source.osm}`), {
            headers: { Accept: 'application/json' },
            signal: deps.signal,
          });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GeoFailure('timeout', 'OpenStreetMap took too long to answer.');
    }
    throw new GeoFailure('network', 'Could not reach OpenStreetMap for the building outline.');
  }
  if (response.status === 429 || response.status === 503 || response.status === 504) {
    throw new GeoFailure('timeout', 'OpenStreetMap is busy. Wait a moment and try again.');
  }
  if (!response.ok) throw new GeoFailure('network', 'OpenStreetMap could not return the building outline.');
  const body = await response.text();
  let elements: OverpassElement[];
  try {
    elements = parseElements(body);
  } catch {
    throw new GeoFailure('network', 'OpenStreetMap returned an unexpected building response.');
  }
  await deps.cache.set(cacheKey, body).catch(() => undefined);
  return elements;
}

function parseElements(body: string): OverpassElement[] {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Not an Overpass response.');
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.elements)) {
    if (typeof record.remark === 'string') throw new Error(record.remark);
    throw new Error('Not an Overpass response.');
  }
  return withGeometry(record.elements.filter((item): item is OverpassElement => typeof item === 'object' && item !== null));
}

/** The main API lists a way's node ids and the nodes separately. Give ways and members their coordinates, as Overpass does. */
function withGeometry(elements: OverpassElement[]): OverpassElement[] {
  const nodes = new Map<number, OsmPoint>();
  for (const element of elements) {
    if (element.type === 'node' && element.lat !== undefined && element.lon !== undefined) {
      nodes.set(element.id, { lat: element.lat, lon: element.lon });
    }
  }
  if (nodes.size === 0) return elements;
  const ways = new Map<number, OsmPoint[]>();
  const shaped = elements.map((element) => {
    if (element.type !== 'way' || element.geometry !== undefined || element.nodes === undefined) return element;
    const geometry = element.nodes.map((id) => nodes.get(id)).filter((point): point is OsmPoint => point !== undefined);
    ways.set(element.id, geometry);
    return { ...element, geometry };
  });
  return shaped.map((element) => {
    if (element.type !== 'relation' || element.members === undefined) return element;
    const members = element.members.map((member) =>
      member.geometry === undefined && member.type === 'way' && member.ref !== undefined && ways.has(member.ref)
        ? { ...member, geometry: ways.get(member.ref) }
        : member,
    );
    return { ...element, members };
  });
}

function toBuildings(element: OverpassElement, label: string): GeographicBuilding[] {
  if (element.tags?.building === undefined && element.tags?.['building:part'] === undefined) return [];
  if (element.type === 'way') {
    const ring = closedRing(element.geometry);
    if (ring === null) return [];
    return [buildingOf(element, label, [{ outer: ring, holes: [] }])];
  }
  if (element.type !== 'relation' || element.members === undefined) return [];
  const outers = stitch(element.members.filter((member) => member.role !== 'inner').map((member) => member.geometry ?? []));
  const inners = stitch(element.members.filter((member) => member.role === 'inner').map((member) => member.geometry ?? []));
  if (outers.length === 0) return [];
  const parts: GeographicRing[] = outers.map((outer) => ({
    outer,
    holes: inners.filter((hole) => hole[0] !== undefined && ringContains(outer, hole[0])),
  }));
  return [buildingOf(element, label, parts)];
}

function buildingOf(element: OverpassElement, label: string, parts: GeographicRing[]): GeographicBuilding {
  const name = element.tags?.name;
  return {
    id: `${element.type}/${element.id}`,
    label: name ?? label,
    tags: element.tags ?? {},
    parts,
    provenance: { source: 'osm', confidence: 0.8, note: `${element.type} ${element.id}` },
  };
}

function stitch(lines: OsmPoint[][]): LngLat[][] {
  const pool = lines
    .filter((line) => line.length >= 2)
    .map((line) => line.map((point) => ({ longitude: point.lon, latitude: point.lat })));
  const closed: LngLat[][] = [];
  while (pool.length > 0) {
    let chain = pool.pop();
    if (chain === undefined) break;
    if (isClosed(chain)) {
      closed.push(chain.slice(0, -1));
      continue;
    }
    let progressed = true;
    while (progressed && !isClosed(chain)) {
      progressed = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i];
        if (other === undefined) continue;
        const merged = tryMerge(chain, other);
        if (merged !== null) {
          chain = merged;
          pool.splice(i, 1);
          progressed = true;
          break;
        }
      }
    }
    if (isClosed(chain)) closed.push(chain.slice(0, -1));
  }
  return closed.filter((ring) => ring.length >= 3);
}

function tryMerge(chain: LngLat[], other: LngLat[]): LngLat[] | null {
  const start = chain[0];
  const end = chain[chain.length - 1];
  const otherStart = other[0];
  const otherEnd = other[other.length - 1];
  if (start === undefined || end === undefined || otherStart === undefined || otherEnd === undefined) return null;
  if (same(end, otherStart)) return chain.concat(other.slice(1));
  if (same(end, otherEnd)) return chain.concat([...other].reverse().slice(1));
  if (same(start, otherEnd)) return other.slice(0, -1).concat(chain);
  if (same(start, otherStart)) return [...other].reverse().slice(0, -1).concat(chain);
  return null;
}

function closedRing(geometry: OsmPoint[] | undefined): LngLat[] | null {
  if (geometry === undefined || geometry.length < 4) return null;
  const ring = geometry.map((point) => ({ longitude: point.lon, latitude: point.lat }));
  if (!same(ring[0], ring[ring.length - 1])) return null;
  return ring.slice(0, -1);
}

function isClosed(ring: LngLat[]): boolean {
  return ring.length >= 4 && same(ring[0], ring[ring.length - 1]);
}

function same(a: LngLat | undefined, b: LngLat | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return Math.abs(a.latitude - b.latitude) < 1e-7 && Math.abs(a.longitude - b.longitude) < 1e-7;
}

function ringContains(outer: LngLat[], point: LngLat): boolean {
  const local = outer.map((vertex) => projectToLocal(vertex, point));
  return pointInRing({ east: 0, north: 0 }, local);
}

function ringArea(points: { east: number; north: number }[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    twice += current.east * next.north - next.east * current.north;
  }
  return twice / 2;
}

function distanceToRing(points: { east: number; north: number }[]): number {
  if (pointInRing({ east: 0, north: 0 }, points)) return 0;
  let best = Infinity;
  for (const point of points) best = Math.min(best, Math.hypot(point.east, point.north));
  return best;
}

export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
  /** A turned box inside the bounds. Only buildings centred in it are kept. */
  corners?: readonly LngLat[];
}

const MAX_BOX_M = 700;
const MAX_BUILDINGS = 40;

/** Buildings whose centers fall inside a map box. A box wider than a few blocks is refused. */
export async function loadBuildingsInBounds(bounds: MapBounds, deps: OverpassDeps): Promise<GeographicBuilding[]> {
  const width = metersEast(bounds.east - bounds.west, (bounds.south + bounds.north) / 2);
  const height = metersNorth(bounds.north - bounds.south);
  if (Math.max(Math.abs(width), Math.abs(height)) > MAX_BOX_M) {
    throw new GeoFailure('not-found', 'That box is too big. Zoom in and shift-drag across a few blocks.');
  }
  const key = `overpass:bbox:${bounds.south.toFixed(5)}:${bounds.west.toFixed(5)}:${bounds.north.toFixed(5)}:${bounds.east.toFixed(5)}`;
  const elements = await fetchElements({ overpass: boundsQuery(bounds) }, key, deps);
  const boxArea = Math.abs(width * height);
  const buildings = elements
    .flatMap((element) => toBuildings(element, element.tags?.name ?? 'Building'))
    .filter((building) => centerInside(building, bounds) && buildingArea(building) <= boxArea * 1.5)
    .filter((building) => bounds.corners === undefined || centerInsideRing(building, bounds.corners))
    .slice(0, MAX_BUILDINGS);
  if (buildings.length === 0) {
    throw new GeoFailure('not-found', 'No buildings in that box. Shift-drag across the gray building shapes.');
  }
  return buildings;
}

function metersEast(deltaLongitude: number, latitude: number): number {
  return deltaLongitude * (Math.PI / 180) * 6378137 * Math.cos((latitude * Math.PI) / 180);
}

function metersNorth(deltaLatitude: number): number {
  return deltaLatitude * (Math.PI / 180) * 6378137;
}

function centerInside(building: GeographicBuilding, bounds: MapBounds): boolean {
  const ring = building.parts[0]?.outer;
  if (ring === undefined || ring.length === 0) return false;
  const latitude = ring.reduce((sum, point) => sum + point.latitude, 0) / ring.length;
  const longitude = ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length;
  return latitude >= bounds.south && latitude <= bounds.north && longitude >= bounds.west && longitude <= bounds.east;
}

function centerInsideRing(building: GeographicBuilding, corners: readonly LngLat[]): boolean {
  const ring = building.parts[0]?.outer;
  if (ring === undefined || ring.length === 0) return false;
  const center = {
    latitude: ring.reduce((sum, point) => sum + point.latitude, 0) / ring.length,
    longitude: ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length,
  };
  return pointInRing({ east: 0, north: 0 }, corners.map((corner) => projectToLocal(corner, center)));
}

function buildingArea(building: GeographicBuilding): number {
  const origin = building.parts[0]?.outer[0];
  if (origin === undefined) return 0;
  return building.parts.reduce((total, part) => {
    const local = part.outer.map((point) => projectToLocal(point, origin));
    return total + Math.abs(ringArea(local));
  }, 0);
}

function boundsQuery(bounds: MapBounds): string {
  const box = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `[out:json][timeout:25];way["building"](${box});out geom;`;
}

function partsBuildingIn(elements: OverpassElement[]): GeographicBuilding | null {
  const relation = elements.find((element) => element.type === 'relation' && element.tags?.type === 'building');
  if (relation === undefined) return null;
  return relationBuilding(relation, waysOf(elements));
}

function aroundQuery(latitude: number, longitude: number): string {
  return `[out:json][timeout:25];(way["building"](around:${AROUND_M},${latitude},${longitude});relation["building"](around:${AROUND_M},${latitude},${longitude}););out geom;`;
}

function aroundKey(hit: GeocodeHit): string {
  return `overpass:around:${hit.latitude.toFixed(5)}:${hit.longitude.toFixed(5)}`;
}
