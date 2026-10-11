import type { LookupCache } from './cache.ts';
import { sendRequest } from './request.ts';
import { sameOrigin } from './sameOrigin.ts';

export interface GeocodeHit {
  label: string;
  latitude: number;
  longitude: number;
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
}

export type GeoFailureKind = 'not-found' | 'timeout' | 'network';

export class GeoFailure extends Error {
  readonly kind: GeoFailureKind;

  constructor(kind: GeoFailureKind, message: string) {
    super(message);
    this.name = 'GeoFailure';
    this.kind = kind;
  }
}

export interface GeocodeDeps {
  fetch: typeof fetch;
  cache: LookupCache;
  signal?: AbortSignal;
}

const ENDPOINT = '/api/nominatim/search';

/** Search Nominatim. A repeated query is served from the cache and does not call the network. */
export async function searchAddresses(query: string, deps: GeocodeDeps): Promise<GeocodeHit[]> {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (normalized.length < 3) return [];
  const key = `nominatim:${normalized.toLowerCase()}`;
  // A broken or full browser store must not fail the search.
  const cached = await deps.cache.get(key).catch(() => undefined);
  if (cached !== undefined) return parseHits(cached);

  const url = sameOrigin(ENDPOINT);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('q', normalized);
  url.searchParams.set('limit', '5');
  let response: Response;
  try {
    response = await fetchSearch(url, deps);
  } catch (error) {
    if (isAbort(error) || deps.signal?.aborted) throw new GeoFailure('timeout', 'The address search timed out.');
    try {
      response = await fetchSearch(url, deps);
    } catch (retryError) {
      if (isAbort(retryError) || deps.signal?.aborted) throw new GeoFailure('timeout', 'The address search timed out.');
      throw new GeoFailure('network', 'The address search could not reach the map service.');
    }
  }
  if (response.status === 429) throw new GeoFailure('timeout', 'The address search is rate limited. Wait a moment and try again.');
  if (!response.ok) {
    throw new GeoFailure('network', `The address search was refused (${response.status}). Wait a moment and try again.`);
  }
  const body = await response.text();
  let hits: GeocodeHit[];
  try {
    hits = parseHits(body);
  } catch {
    throw new GeoFailure('network', 'The address search returned an unexpected response.');
  }
  if (hits.length === 0) throw new GeoFailure('not-found', 'No place matched that address.');
  await deps.cache.set(key, body).catch(() => undefined);
  return hits;
}

function parseHits(body: string): GeocodeHit[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('Not a search result list.');
  const hits: GeocodeHit[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const latitude = Number(record.lat);
    const longitude = Number(record.lon);
    const osmId = Number(record.osm_id);
    const osmType = record.osm_type;
    const label = typeof record.display_name === 'string' ? record.display_name : '';
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(osmId) || label === '') continue;
    if (osmType !== 'node' && osmType !== 'way' && osmType !== 'relation') continue;
    hits.push({ label, latitude, longitude, osmType, osmId });
  }
  return hits;
}

function fetchSearch(url: URL, deps: GeocodeDeps): Promise<Response> {
  return sendRequest(deps.fetch, url, {
    headers: { Accept: 'application/json' },
    signal: deps.signal,
  });
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** A short street address for a point, such as "123 Main Street", or null when there is none nearby. */
export async function reverseGeocode(latitude: number, longitude: number, deps: GeocodeDeps): Promise<string | null> {
  const key = `nominatim-reverse:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  let body = await deps.cache.get(key).catch(() => undefined);
  if (body === undefined) {
    const url = sameOrigin('/api/nominatim/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('zoom', '18');
    const response = await fetchSearch(url, deps);
    if (!response.ok) return null;
    body = await response.text();
    await deps.cache.set(key, body).catch(() => undefined);
  }
  return parseReverse(body);
}

function parseReverse(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const address = (typeof record.address === 'object' && record.address !== null ? record.address : {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
    const street = [text(address.house_number), text(address.road)].filter((part) => part !== undefined).join(' ');
    const name = text(record.name);
    const area = text(address.neighbourhood) ?? text(address.suburb) ?? text(address.city) ?? text(address.town);
    return [name ?? (street === '' ? undefined : street), area].filter((part) => part !== undefined).join(', ') || null;
  } catch {
    return null;
  }
}
