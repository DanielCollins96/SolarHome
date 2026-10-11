import { describe, expect, it } from 'vitest';
import { createLookupCache } from '../src/geo/cache.ts';
import { GeoFailure, searchAddresses } from '../src/geo/geocode.ts';
import {
  buildingFromElements,
  loadBuilding,
  loadBuildingsInBounds,
  loadWholeBuilding,
  wholeBuildingFromElements,
} from '../src/geo/overpass.ts';

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
    // The first lookup asks for the way's parent buildings, the way itself, and the map inside it for loose parts.
    expect(calls).toBe(3);
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
        { type: 'way', id: 1, tags: { building: 'civic', 'building:part': 'yes', height: '8' }, geometry: podium },
        { type: 'way', id: 2, tags: { 'building:part': 'office', height: '70', min_height: '8' }, geometry: tower },
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

  it('turns a search hit on an outline into its building of parts', async () => {
    const base = ring(43.6424, -79.3873, 0.0004, 0.0005);
    const shaft = ring(43.6425, -79.3871, 0.0001, 0.0001);
    const elements = [
      { type: 'way', id: 1, tags: { building: 'yes', 'building:part': 'no', height: '553', name: 'CN Tower' }, geometry: base },
      {
        type: 'relation',
        id: 14629176,
        tags: { type: 'building', name: 'CN Tower' },
        members: [
          { type: 'way', ref: 1, role: 'outline' },
          { type: 'way', ref: 2, role: 'part' },
        ],
      },
      { type: 'way', id: 2, tags: { 'building:part': 'yes', height: '440' }, geometry: shaft },
    ];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ elements }), { status: 200 });
    const hit = { label: 'CN Tower', latitude: 43.6425, longitude: -79.387, osmType: 'way' as const, osmId: 1 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() });
    expect(building.id).toBe('relation/14629176');
    expect(building.parts).toHaveLength(1);
    expect(building.parts[0]?.tags?.height).toBe('440');
  });

  it('still returns the building when the browser cache cannot save it', async () => {
    const way = { type: 'way', id: 4, tags: { building: 'yes' }, geometry: ring(1, 2, 0.0001, 0.0001) };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ elements: [way] }), { status: 200 });
    const full = createLookupCache({
      get: async () => {
        throw new Error('IndexedDB is unavailable.');
      },
      set: async () => {
        throw new Error('QuotaExceededError');
      },
    });
    const hit = { label: 'Full', latitude: 1, longitude: 2, osmType: 'way' as const, osmId: 4 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: full });
    expect(building.id).toBe('way/4');
  });

  it('keeps only buildings inside a turned box, not its whole bounding rectangle', async () => {
    // A diamond inside the bounds. One house sits in its middle, one in a corner of the bounds outside it.
    const inside = { type: 'way', id: 1, tags: { building: 'yes' }, geometry: ring(1.00195, 2.00195, 0.0001, 0.0001) };
    const corner = { type: 'way', id: 2, tags: { building: 'yes' }, geometry: ring(1.00002, 2.00002, 0.0001, 0.0001) };
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ elements: [inside, corner] }), { status: 200 });
    const bounds = {
      south: 1,
      west: 2,
      north: 1.004,
      east: 2.004,
      corners: [
        { latitude: 1, longitude: 2.002 },
        { latitude: 1.002, longitude: 2.004 },
        { latitude: 1.004, longitude: 2.002 },
        { latitude: 1.002, longitude: 2 },
      ],
    };
    const buildings = await loadBuildingsInBounds(bounds, { fetch: fetchImpl, cache: createLookupCache() });
    expect(buildings.map((building) => building.id)).toEqual(['way/1']);
  });

  it('reads the main API format, where ways list node ids', async () => {
    const nodes = [
      { type: 'node', id: 11, lat: 1, lon: 2 },
      { type: 'node', id: 12, lat: 1, lon: 2.0001 },
      { type: 'node', id: 13, lat: 1.0001, lon: 2.0001 },
      { type: 'node', id: 14, lat: 1.0001, lon: 2 },
    ];
    const way = { type: 'way', id: 7, nodes: [11, 12, 13, 14, 11], tags: { building: 'yes', name: 'Shed' } };
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input);
      const elements = path.includes('/relations.json') ? [] : [...nodes, way];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    };
    const hit = { label: 'Shed', latitude: 1.00005, longitude: 2.00005, osmType: 'way' as const, osmId: 7 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() });
    expect(building.id).toBe('way/7');
    expect(building.parts[0]?.outer).toHaveLength(4);
  });

  it('finds the building of parts around a click, from the map data near it', async () => {
    const base = ring(43.6424, -79.3873, 0.0004, 0.0005);
    const shaft = ring(43.6425, -79.3871, 0.0001, 0.0001);
    const relation = {
      type: 'relation',
      id: 14629176,
      tags: { type: 'building', name: 'CN Tower' },
      members: [
        { type: 'way', ref: 1, role: 'outline' },
        { type: 'way', ref: 2, role: 'part' },
      ],
    };
    const outline = { type: 'way', id: 1, tags: { building: 'yes', 'building:part': 'no', height: '553' }, geometry: base };
    const part = { type: 'way', id: 2, tags: { 'building:part': 'yes', height: '440' }, geometry: shaft };
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input);
      asked.push(path.replace(/^.*\/api\/osm/, ''));
      // The map box lists the relation but only the members inside the box.
      const elements = path.includes('/map.json') ? [relation, outline] : [relation, outline, part];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    };
    const building = await loadWholeBuilding(43.6425, -79.38705, { fetch: fetchImpl, cache: createLookupCache() });
    expect(building.id).toBe('relation/14629176');
    expect(building.parts.map((item) => item.tags?.height)).toEqual(['440']);
    expect(asked.some((path) => path.startsWith('/relation/14629176/full.json'))).toBe(true);
  });

  it('gathers loose parts inside an outline, as the Eiffel Tower is mapped', async () => {
    const legs = ring(48.8577, 2.2938, 0.0011, 0.0016);
    const outline = { type: 'way', id: 5013364, tags: { building: 'tower', 'building:part': 'no', height: '330', name: 'Tour Eiffel' }, geometry: legs };
    const floor = { type: 'way', id: 1, tags: { 'building:part': 'yes', height: '64', min_height: '57.63' }, geometry: ring(48.8580, 2.2943, 0.0003, 0.0004) };
    const antenna = { type: 'way', id: 2, tags: { 'building:part': 'yes', height: '330', min_height: '300' }, geometry: ring(48.85825, 2.29448, 0.00002, 0.00003) };
    const outside = { type: 'way', id: 3, tags: { 'building:part': 'yes', height: '3' }, geometry: ring(48.8600, 2.2990, 0.0001, 0.0001) };
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input);
      const elements = path.includes('/relations.json') ? [] : path.includes('/map.json') ? [outline, floor, antenna, outside] : [outline];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    };
    const hit = { label: 'Eiffel Tower', latitude: 48.85826, longitude: 2.2945, osmType: 'way' as const, osmId: 5013364 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() });
    expect(building.label).toBe('Tour Eiffel');
    expect(building.parts.map((part) => part.tags?.height)).toEqual(['64', '330']);
  });

  it('keeps the outline when its loose parts stop far short of it, as the Calgary Tower is mapped', async () => {
    const outline = { type: 'way', id: 25719793, tags: { building: 'yes', height: '191', name: 'Calgary Tower' }, geometry: ring(51.0441, -114.0634, 0.0003, 0.0005) };
    const base = { type: 'way', id: 1, tags: { 'building:part': 'yes', 'building:levels': '3' }, geometry: ring(51.04425, -114.0632, 0.0001, 0.0001) };
    const fetchImpl: typeof fetch = async (input) => {
      const path = String(input);
      const elements = path.includes('/relations.json') ? [] : path.includes('/map.json') ? [outline, base] : [outline];
      return new Response(JSON.stringify({ elements }), { status: 200 });
    };
    const hit = { label: 'Calgary Tower', latitude: 51.0443, longitude: -114.0631, osmType: 'way' as const, osmId: 25719793 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache() });
    expect(building.parts.map((part) => part.tags?.height ?? part.tags?.['building:levels'])).toEqual(['191', '3']);
  });

  it('leaves out an outline that only stands in for the parts', () => {
    const base = ring(43.6424, -79.3873, 0.0004, 0.0005);
    const shaft = ring(43.6425, -79.3871, 0.0001, 0.0001);
    const building = wholeBuildingFromElements(
      [
        {
          type: 'relation',
          id: 14629176,
          tags: { type: 'building', name: 'CN Tower' },
          members: [
            { type: 'way', ref: 1, role: 'outline' },
            { type: 'way', ref: 2, role: 'part' },
          ],
        },
        { type: 'way', id: 1, tags: { building: 'yes', 'building:part': 'no', height: '553' }, geometry: base },
        { type: 'way', id: 2, tags: { 'building:part': 'yes', height: '440' }, geometry: shaft },
      ],
      // On the base but outside the shaft: the outline still decides which building was clicked.
      43.64242,
      -79.38728,
    );
    expect(building?.id).toBe('relation/14629176');
    expect(building?.parts).toHaveLength(1);
    expect(building?.parts[0]?.tags?.height).toBe('440');
  });

  it('retries a busy Overpass response, then reports a timeout', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response('busy', { status: 504 });
    };
    const hit = { label: 'Busy', latitude: 1, longitude: 2, osmType: 'way' as const, osmId: 4 };
    const deps = { fetch: fetchImpl, cache: createLookupCache(), retryDelaysMs: [0, 0] };
    await expect(loadBuilding(hit, deps)).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBe(3);
  });

  it('succeeds when Overpass answers after a busy response', async () => {
    let calls = 0;
    const way = { type: 'way', id: 4, tags: { building: 'yes' }, geometry: ring(1, 2, 0.0001, 0.0001) };
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response('busy', { status: 504 });
      return new Response(JSON.stringify({ elements: [way] }), { status: 200 });
    };
    const hit = { label: 'Busy', latitude: 1, longitude: 2, osmType: 'way' as const, osmId: 4 };
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache: createLookupCache(), retryDelaysMs: [0] });
    expect(building.id).toBe('way/4');
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
