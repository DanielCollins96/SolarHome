import { describe, expect, it } from 'vitest';
import { withCalgaryHeights } from '../src/geo/calgary.ts';
import type { GeographicBuilding } from '../src/house/assemble.ts';

/** A 40 m square in Calgary's Beltline, as OSM traces it. */
const square = [
  { longitude: -114.0525, latitude: 51.0372 },
  { longitude: -114.0519, latitude: 51.0372 },
  { longitude: -114.0519, latitude: 51.0376 },
  { longitude: -114.0525, latitude: 51.0376 },
  { longitude: -114.0525, latitude: 51.0372 },
];

function building(tags: Record<string, string>, outer = square): GeographicBuilding {
  return { id: 'way/1', label: 'Arena', tags, parts: [{ outer, holes: [] }], provenance: { source: 'osm', confidence: 0.7 } };
}

/** The city's outline is traced a little wider than OSM's, as it often is. */
function cityRow(heightM: number, pad = 0.00002) {
  return {
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [-114.0525 - pad, 51.0372 - pad],
          [-114.0519 + pad, 51.0372 - pad],
          [-114.0519 + pad, 51.0376 + pad],
          [-114.0525 - pad, 51.0376 + pad],
          [-114.0525 - pad, 51.0372 - pad],
        ],
      ],
    },
    grd_elev_min_z: '1040.0',
    rooftop_elev_z: String(1040 + heightM),
  };
}

function cityFetch(rows: unknown[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

describe('City of Calgary heights', () => {
  it('fills in the measured height when OSM has none', async () => {
    const seen: string[] = [];
    const result = await withCalgaryHeights(building({ building: 'yes' }), cityFetch([cityRow(42.7)], seen));
    expect(result.parts[0]?.tags?.height).toBe('42.7');
    // Outlines that only touch the box count, not just those wholly inside it.
    expect(decodeURIComponent(seen[0] ?? '')).toContain('intersects(polygon');
  });

  it('keeps an OSM height and does not ask the city', async () => {
    const seen: string[] = [];
    const original = building({ building: 'yes', height: '20' });
    expect(await withCalgaryHeights(original, cityFetch([cityRow(42.7)], seen))).toBe(original);
    expect(seen).toHaveLength(0);
  });

  it('skips buildings outside Calgary', async () => {
    const seen: string[] = [];
    const toronto = square.map((point) => ({ longitude: point.longitude + 34.67, latitude: point.latitude - 7.38 }));
    await withCalgaryHeights(building({ building: 'yes' }, toronto), cityFetch([cityRow(42.7)], seen));
    expect(seen).toHaveLength(0);
  });

  it('does not borrow the height of a neighbour that only shares a wall', async () => {
    const neighbour = cityRow(90);
    neighbour.polygon.coordinates = [
      [
        [-114.0519, 51.0372],
        [-114.0513, 51.0372],
        [-114.0513, 51.0376],
        [-114.0519, 51.0376],
        [-114.0519, 51.0372],
      ],
    ];
    const original = building({ building: 'yes' });
    expect(await withCalgaryHeights(original, cityFetch([neighbour]))).toBe(original);
  });
});
