import { describe, expect, it } from 'vitest';
import type { GeographicBuilding } from '../src/house/assemble.ts';
import { createSavedPlaces, MAX_RECENT } from '../src/scene/savedPlaces.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

function building(id: string, latitude: number, longitude: number): GeographicBuilding {
  const ring = [
    { latitude, longitude },
    { latitude: latitude + 0.0001, longitude },
    { latitude: latitude + 0.0001, longitude: longitude + 0.0001 },
  ];
  return { id, label: 'Building', tags: { building: 'yes' }, parts: [{ outer: ring, holes: [] }], provenance: { source: 'osm', confidence: 0.75, note: '' } };
}

const calgary = { latitude: 51.0447, longitude: -114.0719 };

describe('saved places', () => {
  it('keeps the home across page loads', () => {
    const storage = memoryStorage();
    createSavedPlaces(storage).setHome({ label: '123 Main Street', at: calgary, buildings: [building('way/1', 51.0447, -114.0719)] });
    const home = createSavedPlaces(storage).home();
    expect(home?.label).toBe('123 Main Street');
    expect(home?.buildings?.[0]?.id).toBe('way/1');
  });

  it('moves a revisited place to the top instead of listing it twice', () => {
    const places = createSavedPlaces(memoryStorage());
    places.visit({ label: 'A', at: calgary, buildings: [building('way/1', 51.0447, -114.0719)] });
    places.visit({ label: 'B', at: { latitude: 43.65, longitude: -79.38 }, buildings: [building('way/2', 43.65, -79.38)] });
    places.visit({ label: 'A and garage', at: calgary, buildings: [building('way/1', 51.0447, -114.0719), building('way/3', 51.0447, -114.0718)] });
    expect(places.recent().map((place) => place.label)).toEqual(['A and garage', 'B']);
  });

  it('lists the house next door as its own place', () => {
    const places = createSavedPlaces(memoryStorage());
    places.visit({ label: 'Mine', at: calgary, buildings: [building('way/1', 51.0447, -114.0719)] });
    places.visit({ label: 'Next door', at: { latitude: 51.0447, longitude: -114.0717 }, buildings: [building('way/2', 51.0447, -114.0717)] });
    expect(places.recent()).toHaveLength(2);
  });

  it('keeps only the most recent places', () => {
    const places = createSavedPlaces(memoryStorage());
    for (let index = 0; index < MAX_RECENT + 3; index += 1) {
      places.visit({ label: `P${index}`, at: { latitude: 40 + index, longitude: -100 } });
    }
    expect(places.recent()).toHaveLength(MAX_RECENT);
    expect(places.recent()[0]?.label).toBe(`P${MAX_RECENT + 2}`);
  });

  it('ignores a damaged store', () => {
    const storage = memoryStorage();
    storage.setItem('solarhome.places.v1', '{not json');
    expect(createSavedPlaces(storage).recent()).toEqual([]);
  });
});
