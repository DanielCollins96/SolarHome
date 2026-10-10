/** A plan-view point in local meters. East and north are both positive. */
export interface PlanPoint {
  east: number;
  north: number;
}

/**
 * Centroid of a simple polygon. The ring is not closed: the first vertex is
 * not repeated at the end. Either winding works; a zero-area ring throws.
 */
export function polygonCentroid(points: readonly PlanPoint[]): PlanPoint {
  if (points.length < 3) {
    throw new Error('A footprint needs at least 3 vertices.');
  }

  let twiceArea = 0;
  let eastMoment = 0;
  let northMoment = 0;

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current === undefined || next === undefined) {
      throw new Error('Footprint vertex is missing.');
    }
    const cross = current.east * next.north - next.east * current.north;
    twiceArea += cross;
    eastMoment += (current.east + next.east) * cross;
    northMoment += (current.north + next.north) * cross;
  }

  if (Math.abs(twiceArea) < 1e-8) {
    throw new Error('Footprint area is zero.');
  }

  return {
    east: eastMoment / (3 * twiceArea),
    north: northMoment / (3 * twiceArea),
  };
}

/** Translate a footprint so its centroid is at the plan origin. */
export function centerPolygon(points: readonly PlanPoint[]): {
  points: PlanPoint[];
  centroid: PlanPoint;
} {
  const centroid = polygonCentroid(points);
  return {
    centroid,
    points: points.map((point) => ({
      east: point.east - centroid.east,
      north: point.north - centroid.north,
    })),
  };
}
