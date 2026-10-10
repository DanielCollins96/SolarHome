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
  const cached = await deps.cache.get(key);
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
  await deps.cache.set(key, body);
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
