import { describe, expect, it } from 'vitest';
import { demoHouseModel } from '../src/house/demoHouse.ts';
import type { HouseModel } from '../src/house/houseModel.ts';
import { compareBuildingId, compareModel, comparePlaceId, lineUp, planBounds } from '../src/scene/compareLayout.ts';

/** A flat-roofed box `width` east–west and `depth` north–south, centred on (east, north). */
function box(width: number, depth: number, east = 0, north = 0): HouseModel {
  const base = demoHouseModel();
  const part = base.parts[0];
  if (part === undefined) throw new Error('The demo house has no parts.');
  return {
    ...base,
    parts: [
      {
        ...part,
        footprint: [
          { east: east - width / 2, north: north - depth / 2 },
          { east: east + width / 2, north: north - depth / 2 },
          { east: east + width / 2, north: north + depth / 2 },
          { east: east - width / 2, north: north + depth / 2 },
        ],
        holes: [],
      },
    ],
  };
}

describe('comparing places', () => {
  it('stands models in a row, west to east, a gap apart and centred on the origin', () => {
    const offsets = lineUp([box(10, 10), box(30, 6, 5, 8)], 20);
    // 10 + 20 + 30 = 60 m of row, from -30 to 30.
    expect(offsets[0]).toEqual({ east: -25, north: -0 });
    // The second box runs from -10 to 20 in its own frame and must start at 0.
    expect(offsets[1]).toEqual({ east: 10, north: -8 });
  });

  it('moves each place by its offset and tags its parts with the place', () => {
    const model = compareModel(
      [
        { placeId: 'cn', model: box(10, 10), offset: { east: -20, north: 0 } },
        { placeId: 'burj', model: box(10, 10), offset: { east: 20, north: 5 } },
      ],
      'Comparing 2 places',
    );
    expect(model.parts.map((part) => part.sourceId)).toEqual([compareBuildingId('cn'), compareBuildingId('burj')]);
    const second = model.parts[1];
    expect(second === undefined ? null : planBounds({ ...model, parts: [second] })).toEqual({ west: 15, east: 25, south: 0, north: 10 });
    expect(comparePlaceId(compareBuildingId('burj'))).toBe('burj');
    expect(comparePlaceId('way/1')).toBeNull();
  });
});
