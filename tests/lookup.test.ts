import { describe, expect, it } from 'vitest';
import { createLookupCache } from '../src/geo/cache.ts';
import { GeoFailure, searchAddresses } from '../src/geo/geocode.ts';
import { buildingFromElements, loadBuilding, wholeBuildingFromElements } from '../src/geo/overpass.ts';

const nominatimBody = JSON.stringify([
  {
    lat: '40.7484421',
    lon: '-73.9856589',
    osm_type: 'way',
    osm_id: 34633854,
    display_name: 'Empire State Building, New York',
  },
]);

describe('address search cache', () => {
  it('does not fetch a repeated query', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(nominatimBody, { status: 200 });
    };
    const cache = createLookupCache();
    const first = await searchAddresses('Empire State Building', { fetch: fetchImpl, cache });
    const second = await searchAddresses('  empire   state building ', { fetch: fetchImpl, cache });
    expect(first[0]?.osmId).toBe(34633854);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(cache.wasMemoryHit()).toBe(true);
  });

  it('calls fetch with the window as its receiver', async () => {
    const fetchImpl = function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return Promise.resolve(new Response(nominatimBody, { status: 200 }));
    } as typeof fetch;
    const hits = await searchAddresses('Calgary Alberta', { fetch: fetchImpl, cache: createLookupCache() });
    expect(hits[0]?.label).toBe('Empire State Building, New York');
  });

  it('reports a missing address and a rate limit', async () => {
    const cache = createLookupCache();
    const empty: typeof fetch = async () => new Response('[]', { status: 200 });
    await expect(searchAddresses('nowhere special', { fetch: empty, cache })).rejects.toMatchObject({
      kind: 'not-found',
    });
    const limited: typeof fetch = async () => new Response('slow down', { status: 429 });
    await expect(searchAddresses('again please', { fetch: limited, cache })).rejects.toBeInstanceOf(GeoFailure);
  });
});

describe('building lookup', () => {
  it('does not treat a city boundary as a house', () => {
    const boundary = buildingFromElements(
      [
        {
          type: 'relation',
          id: 1,
          tags: { boundary: 'administrative', name: 'Calgary' },
          members: [
            {
              type: 'way',
              role: 'outer',
              geometry: [
                { lat: 51, lon: -114 },
                { lat: 51.1, lon: -114 },
                { lat: 51.1, lon: -113.9 },
                { lat: 51, lon: -114 },
              ],
            },
          ],
        },
      ],
      'Calgary',
    );
    expect(boundary).toBeNull();
  });

  const way = {
    type: 'way',
    id: 9,
    tags: { building: 'house', 'building:levels': '2', name: 'Sample House' },
    geometry: [
      { lat: 40, lon: -105 },
      { lat: 40.0001, lon: -105 },
      { lat: 40.0001, lon: -104.9999 },
      { lat: 40, lon: -104.9999 },
      { lat: 40, lon: -105 },
    ],
  };

  it('uses the cache on the second lookup and keeps a levels-only building', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ elements: [way] }), { status: 200 });
    };
    const cache = createLookupCache();
    const hit = {
      label: 'Sample',
      latitude: 40.00005,
      longitude: -104.99995,
      osmType: 'way' as const,
      osmId: 9,
    };
    const first = await loadBuilding(hit, { fetch: fetchImpl, cache });
    await loadBuilding(hit, { fetch: fetchImpl, cache });
    expect(calls).toBe(1);
    expect(cache.wasMemoryHit()).toBe(true);
    expect(first.label).toBe('Sample House');
    expect(first.tags['building:levels']).toBe('2');
    expect(first.parts[0]?.outer).toHaveLength(4);
  });

  it('says when no building is nearby', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ elements: [] }), { status: 200 });
    const hit = { label: 'Empty', latitude: 1, longitude: 1, osmType: 'node' as const, osmId: 3 };
    await expect(loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() })).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('keeps every part of a building relation', () => {
    const podium = ring(43.653, -79.385, 0.0012, 0.0016);
    const tower = ring(43.6534, -79.3844, 0.0003, 0.0003);
    const building = wholeBuildingFromElements(
      [
        {
          type: 'relation',
          id: 542980,
          tags: { type: 'building', name: 'Toronto City Hall' },
          members: [
            { type: 'way', ref: 1, role: 'outline' },
            { type: 'way', ref: 2, role: 'part' },
          ],
        },
        { type: 'way', id: 1, tags: { building: 'yes', height: '8' }, geometry: podium },
        { type: 'way', id: 2, tags: { building: 'yes', height: '70' }, geometry: tower },
      ],
      43.6536,
      -79.384,
    );
    expect(building?.label).toBe('Toronto City Hall');
    expect(building?.id).toBe('relation/542980');
    expect(building?.parts).toHaveLength(2);
    expect(building?.parts[0]?.tags?.height).toBe('8');
    expect(building?.parts[1]?.tags?.height).toBe('70');
  });

  it('treats a busy Overpass response as a timeout', async () => {
    const fetchImpl: typeof fetch = async () => new Response('busy', { status: 504 });
    const hit = { label: 'Busy', latitude: 1, longitude: 2, osmType: 'way' as const, osmId: 4 };
    await expect(loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

function ring(lat: number, lon: number, height: number, width: number): { lat: number; lon: number }[] {
  return [
    { lat, lon },
    { lat, lon: lon + width },
    { lat: lat + height, lon: lon + width },
    { lat: lat + height, lon },
    { lat, lon },
  ];
}
