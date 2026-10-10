import type { LookupCache } from './cache.ts';
import { GeoFailure, type GeocodeHit } from './geocode.ts';
import { projectToLocal } from './projection.ts';
import type { GeographicBuilding, GeographicRing } from '../house/assemble.ts';
import { pointInRing } from '../house/planGeometry.ts';
import type { LngLat } from './projection.ts';
import { sendRequest } from './request.ts';
import { sameOrigin } from './sameOrigin.ts';

export interface OverpassDeps {
  fetch: typeof fetch;
  cache: LookupCache;
  signal?: AbortSignal;
}

interface OsmPoint {
  lat: number;
  lon: number;
}

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  members?: { type: string; role?: string; geometry?: OsmPoint[] }[];
}

const ENDPOINT = sameOrigin('/api/overpass');
const AROUND_M = 45;

/** Load the building for a geocoder hit. Uses the cache on a repeated lookup. */
export async function loadBuilding(hit: GeocodeHit, deps: OverpassDeps): Promise<GeographicBuilding> {
  if (hit.osmType === 'way' || hit.osmType === 'relation') {
    const direct = await fetchElements(elementQuery(hit.osmType, hit.osmId), `overpass:${hit.osmType}:${hit.osmId}`, deps);
    const building = buildingFromElements(direct, hit.label);
    if (building !== null) return building;
  }
  const around = await fetchElements(aroundQuery(hit.latitude, hit.longitude), aroundKey(hit), deps);
  const chosen = chooseBuilding(around, hit.latitude, hit.longitude, hit.label);
  if (chosen === null) {
    throw new GeoFailure('not-found', 'No building footprint was found there. Search a street address, not only a city.');
  }
  return chosen;
}

/** The building whose footprint contains this point. A nearby neighbor is not returned. */
export async function loadBuildingUnder(latitude: number, longitude: number, deps: OverpassDeps): Promise<GeographicBuilding> {
  const around = await fetchElements(aroundQuery(latitude, longitude), aroundKey({ latitude, longitude, label: '', osmType: 'node', osmId: 0 }), deps);
  const buildings = around.flatMap((element) => toBuildings(element, element.tags?.name ?? 'Building'));
  const containing = buildings.find((building) => buildingContains(building, latitude, longitude));
  if (containing === undefined) {
    throw new GeoFailure('not-found', 'Click on a building. A click between houses does not select a neighbor.');
  }
  return containing;
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

async function fetchElements(query: string, cacheKey: string, deps: OverpassDeps): Promise<OverpassElement[]> {
  const cached = await deps.cache.get(cacheKey);
  if (cached !== undefined) return parseElements(cached);
  let response: Response;
  try {
    response = await sendRequest(deps.fetch, ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: query }),
      signal: deps.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new GeoFailure('timeout', 'OpenStreetMap took too long to answer.');
    }
    throw new GeoFailure('network', 'Could not reach OpenStreetMap for the building outline.');
  }
  if (response.status === 429 || response.status === 504) {
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
  await deps.cache.set(cacheKey, body);
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
  return record.elements.filter((item): item is OverpassElement => typeof item === 'object' && item !== null);
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
  const elements = await fetchElements(boundsQuery(bounds), key, deps);
  const boxArea = Math.abs(width * height);
  const buildings = elements
    .flatMap((element) => toBuildings(element, element.tags?.name ?? 'Building'))
    .filter((building) => centerInside(building, bounds) && buildingArea(building) <= boxArea * 1.5)
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

function elementQuery(osmType: 'way' | 'relation', osmId: number): string {
  return `[out:json][timeout:25];${osmType}(${osmId});out geom;`;
}

function aroundQuery(latitude: number, longitude: number): string {
  return `[out:json][timeout:25];(way["building"](around:${AROUND_M},${latitude},${longitude});relation["building"](around:${AROUND_M},${latitude},${longitude}););out geom;`;
}

function aroundKey(hit: GeocodeHit): string {
  return `overpass:around:${hit.latitude.toFixed(5)}:${hit.longitude.toFixed(5)}`;
}
