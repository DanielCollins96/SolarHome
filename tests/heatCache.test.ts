import { describe, expect, it } from 'vitest';
import { localToLngLat, type LngLat } from '../src/geo/projection.ts';
import { buildingCasters, nextCache, savedCells, staleBuildings, type Caster } from '../src/solar/heatCache.ts';
import { roofGrid } from '../src/solar/roofCells.ts';
import { demoHouseModel } from '../src/house/demoHouse.ts';

const HERE = { latitude: 51.4995, longitude: -0.1248 };

/** A square 10 m across, its south-west corner this far east and north of HERE. */
function square(east: number, north: number): LngLat[] {
  return [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ].map(([e = 0, n = 0]) => localToLngLat({ east: east + e, north: north + n }, HERE));
}

const building = (id: string, east: number, height = 'h6'): Caster => ({ key: `building:${id}:${height}`, building: id, rings: [square(east, 0)], shape: height });
const block = (id: string, east: number, north = 0): Caster => ({ key: `block:${id}`, building: null, rings: [square(east, north)] });

const NO_GRID = { faces: [], cells: [] };

function cacheOf(casters: Caster[]) {
  return nextCache(null, 'sky', casters, NO_GRID, HERE, new Float32Array(), new Float32Array());
}

describe('heatmap reuse', () => {
  it('keeps a building when a neighbour is selected in place of its map block', () => {
    const before = cacheOf([building('a', 0), block('b', 20)]);
    expect([...staleBuildings(before, [building('a', 0), building('b', 20)])]).toEqual([]);
  });

  it('keeps a building when a neighbour is let go and its map block comes back later', () => {
    let cache = cacheOf([building('a', 0), building('b', 20)]);
    // The building goes first; the map redraws its block a moment later.
    expect([...staleBuildings(cache, [building('a', 0)])]).toEqual([]);
    cache = nextCache(cache, 'sky', [building('a', 0)], NO_GRID, HERE, new Float32Array(), new Float32Array());
    expect([...staleBuildings(cache, [building('a', 0), block('b', 20)])]).toEqual([]);
  });

  it('traces a building again when a block appears beside it', () => {
    const before = cacheOf([building('a', 0)]);
    expect([...staleBuildings(before, [building('a', 0), block('c', 30)])]).toEqual(['a']);
  });

  it('keeps a building when the change is beyond the reach shade is counted from', () => {
    const before = cacheOf([building('a', 0), building('far', 500)]);
    expect([...staleBuildings(before, [building('a', 0), building('far', 500), block('c', 520)])]).toEqual(['far']);
  });

  it('traces the neighbours of an edited building', () => {
    const before = cacheOf([building('a', 0), building('b', 20)]);
    expect([...staleBuildings(before, [building('a', 0), building('b', 20, 'h30')])].sort()).toEqual(['a', 'b']);
  });

  it('finds the same squares for the same roof when the model is centred elsewhere', () => {
    const model = demoHouseModel();
    const grid = roofGrid(model);
    const kwh = Float32Array.from(grid.cells, (_, i) => i + 1);
    const cache = nextCache(null, 'sky', buildingCasters(model), grid, model.origin, kwh, kwh);
    // The same house, from a centre 33 m north: its footprint in metres shifts south by as much.
    const shift = (0.0003 * Math.PI * 6_378_137) / 180;
    const moved = {
      ...model,
      origin: { latitude: model.origin.latitude + 0.0003, longitude: model.origin.longitude },
      parts: model.parts.map((part) => ({ ...part, footprint: part.footprint.map((p) => ({ east: p.east, north: p.north - shift })) })),
    };
    expect([...staleBuildings(cache, buildingCasters(moved))]).toEqual([]);
    const found = savedCells(cache, roofGrid(moved), moved.origin, new Set());
    expect(found.map((cell) => cell?.kwh)).toEqual([...kwh]);
  });

  it('traces a stale building again', () => {
    const model = demoHouseModel();
    const grid = roofGrid(model);
    const cache = nextCache(null, 'sky', buildingCasters(model), grid, model.origin, new Float32Array(grid.cells.length), new Float32Array(grid.cells.length));
    const building = grid.faces[0]?.building ?? '';
    expect(savedCells(cache, grid, model.origin, new Set([building])).every((cell) => cell === null)).toBe(true);
  });
});
