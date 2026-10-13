import type { PlanPoint } from '../house/centering.ts';
import type { HouseModel } from '../house/houseModel.ts';

/** Open ground between two places standing side by side. */
export const COMPARE_GAP_M = 20;

/** Parts of a compared place carry this as their building id, so the whole place moves as one. */
const COMPARE_PREFIX = 'compare:';

export function compareBuildingId(placeId: string): string {
  return `${COMPARE_PREFIX}${placeId}`;
}

/** The place a compared building belongs to, or null for an ordinary building. */
export function comparePlaceId(buildingId: string): string | null {
  return buildingId.startsWith(COMPARE_PREFIX) ? buildingId.slice(COMPARE_PREFIX.length) : null;
}

/** East–west and north–south reach of a model's footprints. */
export function planBounds(model: HouseModel): { west: number; east: number; south: number; north: number } {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const part of model.parts) {
    for (const point of part.footprint) {
      west = Math.min(west, point.east);
      east = Math.max(east, point.east);
      south = Math.min(south, point.north);
      north = Math.max(north, point.north);
    }
  }
  if (west > east) return { west: 0, east: 0, south: 0, north: 0 };
  return { west, east, south, north };
}

/**
 * Where each model stands in a west-to-east row, `gapM` apart, the row centred on the origin and
 * each model centred on the row's line.
 */
export function lineUp(models: readonly HouseModel[], gapM = COMPARE_GAP_M): PlanPoint[] {
  const bounds = models.map(planBounds);
  const width = bounds.reduce((sum, box) => sum + (box.east - box.west), 0) + gapM * Math.max(0, models.length - 1);
  let edge = -width / 2;
  return bounds.map((box) => {
    const at = { east: edge - box.west, north: -(box.south + box.north) / 2 };
    edge += box.east - box.west + gapM;
    return at;
  });
}

/** Several places in one model, each moved by its offset and tagged so it can be picked out again. */
export function compareModel(
  entries: readonly { placeId: string; model: HouseModel; offset: PlanPoint }[],
  label: string,
): HouseModel {
  const first = entries[0];
  if (first === undefined) throw new Error('Choose a place to compare.');
  return {
    ...first.model,
    orientationDeg: 0,
    parts: entries.flatMap(({ placeId, model, offset }) =>
      model.parts.map((part, index) => ({
        ...part,
        id: `${placeId}-${index + 1}`,
        sourceId: compareBuildingId(placeId),
        footprint: part.footprint.map((point) => shift(point, offset)),
        holes: part.holes.map((hole) => hole.map((point) => shift(point, offset))),
      })),
    ),
    issues: [],
    label,
  };
}

function shift(point: PlanPoint, by: PlanPoint): PlanPoint {
  return { east: point.east + by.east, north: point.north + by.north };
}
