import { describe, expect, it } from 'vitest';
import { createTreeEdits, type PlacedTree } from '../src/scene/treeEdits.ts';
import { planTrees } from '../src/scene/treeMesh.ts';

function memoryStorage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
}

const spruce: PlacedTree = { id: 'city:a', at: { latitude: 50.9632, longitude: -114.0417 }, kind: 'evergreen', widthM: 6 };
const maple: PlacedTree = { id: 'city:b', at: { latitude: 50.9633, longitude: -114.0417 }, kind: 'deciduous', widthM: 8 };

describe('tree edits', () => {
  it('removes, resizes and retypes a city tree, and finds it again after it shifts a little', () => {
    const storage = memoryStorage();
    const edits = createTreeEdits(storage);
    edits.update(spruce, { kind: 'deciduous', widthM: 4 });
    edits.update(maple, { removed: true });
    // A fresh load from storage, with the city's tree regenerated half a metre away.
    const shifted = { ...spruce, at: { latitude: spruce.at.latitude + 0.0000045, longitude: spruce.at.longitude } };
    const result = createTreeEdits(storage).apply([shifted, maple]);
    expect(result).toEqual([{ ...shifted, kind: 'deciduous', widthM: 4 }]);
  });

  it('plants, resizes and removes a tree of the person’s own', () => {
    const edits = createTreeEdits(memoryStorage());
    const planted = edits.plant({ latitude: 50.9634, longitude: -114.0418 }, 'deciduous', 5);
    edits.update(planted, { widthM: 7 });
    expect(edits.apply([])).toEqual([{ ...planted, widthM: 7 }]);
    edits.update(planted, { removed: true });
    expect(edits.apply([])).toEqual([]);
  });

  it('plants a copy with its own height, which outlasts a reload and leaves the original alone', () => {
    const storage = memoryStorage();
    const edits = createTreeEdits(storage);
    const copy = edits.plant({ latitude: 50.9632, longitude: -114.0416 }, 'evergreen', 6, 17);
    expect(copy.heightM).toBe(17);
    expect(createTreeEdits(storage).apply([spruce])).toEqual([spruce, copy]);
  });

  it('moves a city tree, then moves and resizes it again from its new place', () => {
    const storage = memoryStorage();
    const edits = createTreeEdits(storage);
    const first = { latitude: 50.96335, longitude: -114.0419 };
    const second = { latitude: 50.9634, longitude: -114.042 };
    edits.update(spruce, { at: first });
    const [moved] = edits.apply([spruce]);
    expect(moved?.at).toEqual(first);
    if (moved === undefined) return;
    edits.update(moved, { at: second, widthM: 9 });
    expect(createTreeEdits(storage).apply([spruce])).toEqual([{ ...spruce, at: second, widthM: 9 }]);
  });

  it('keeps a height set apart from the width, and through a change of type', () => {
    const edits = createTreeEdits(memoryStorage());
    edits.update(spruce, { heightM: 9 });
    edits.update(spruce, { widthM: 8, kind: 'deciduous' });
    expect(edits.apply([spruce])).toEqual([{ ...spruce, widthM: 8, heightM: 9, kind: 'deciduous' }]);
  });

  it('moves a planted tree', () => {
    const edits = createTreeEdits(memoryStorage());
    const planted = edits.plant({ latitude: 50.9634, longitude: -114.0418 }, 'deciduous', 5);
    const to = { latitude: 50.96345, longitude: -114.0418 };
    edits.update(planted, { at: to });
    expect(edits.apply([])).toEqual([{ ...planted, at: to }]);
  });

  it('undoes the edits near a place only', () => {
    const edits = createTreeEdits(memoryStorage());
    edits.update(spruce, { removed: true });
    const far = edits.plant({ latitude: 51.05, longitude: -114.07 }, 'evergreen', 5);
    edits.resetAround(spruce.at, 100);
    expect(edits.apply([spruce])).toEqual([spruce, far]);
  });
});

describe('planting trees from the canopy', () => {
  it('fills a merged clump of crowns at a mature spacing, not one tree every few metres', () => {
    // A 20 m by 7 m patch: a row of three or four spruce along a fence.
    const row = [
      { east: 0, north: 0 },
      { east: 20, north: 0 },
      { east: 20, north: 7 },
      { east: 0, north: 7 },
    ];
    const trees = planTrees([{ outline: row }]);
    expect(trees.every((tree) => tree.kind === 'evergreen')).toBe(true);
    expect(trees.length).toBeGreaterThanOrEqual(2);
    expect(trees.length).toBeLessThanOrEqual(4);
  });

  it('keeps trees off the selected building', () => {
    const crown = [
      { east: -2, north: -2 },
      { east: 2, north: -2 },
      { east: 2, north: 2 },
      { east: -2, north: 2 },
    ];
    const house = [
      { east: -5, north: -5 },
      { east: 5, north: -5 },
      { east: 5, north: 5 },
      { east: -5, north: 5 },
    ];
    expect(planTrees([{ outline: crown }], [], [house])).toEqual([]);
  });
});
