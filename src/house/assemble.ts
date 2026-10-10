import { polygonCentroid } from './centering.ts';
import type { PlanPoint } from './centering.ts';
import { cleanFootprint } from './footprintClean.ts';
import { estimateEaveHeight } from './heightEstimate.ts';
import type { HouseModel, HousePart, Provenance } from './houseModel.ts';
import { estimateRoof } from './roofEstimate.ts';
import { localToLngLat, projectRing, type LngLat } from '../geo/projection.ts';

export interface GeographicRing {
  outer: LngLat[];
  holes: LngLat[][];
}

export interface GeographicBuilding {
  id: string;
  label: string;
  tags: Record<string, string>;
  parts: GeographicRing[];
  provenance: Provenance;
}

/** Project, clean, and center a building so its largest footprint centroid is the origin. */
export function assembleHouse(building: GeographicBuilding): HouseModel {
  const anchor = building.parts[0]?.outer[0] ?? { longitude: 0, latitude: 0 };
  const projected = building.parts.map((part) => ({
    outer: projectRing(part.outer, anchor),
    holes: part.holes.map((hole) => projectRing(hole, anchor)),
  }));
  const cleaned = projected.map((part) => ({
    outer: cleanFootprint(part.outer),
    holes: part.holes.map((hole) => cleanFootprint(hole)),
  }));
  const largest = cleaned.reduce((best, part) =>
    Math.abs(polygonArea(part.outer.points)) > Math.abs(polygonArea(best.outer.points)) ? part : best,
  );
  const centroid = polygonCentroid(largest.outer.points);
  const origin = localToLngLat(centroid, anchor);
  const height = estimateEaveHeight({
    osmHeight: building.tags.height,
    osmLevels: building.tags['building:levels'],
  });
  const issues = cleaned.flatMap((part) => [...part.outer.issues, ...part.holes.flatMap((hole) => hole.issues)]);

  const parts: HousePart[] = cleaned.map((part, index) => {
    const footprint = shift(part.outer.points, centroid);
    const holes = part.holes.map((hole) => shift(hole.points, centroid));
    const roof = estimateRoof(building.tags, footprint);
    issues.push(...roof.issues);
    return {
      id: `part-${index + 1}`,
      footprint,
      holes,
      eaveHeightM: height.eaveHeightM,
      roof: roof.roof,
    };
  });

  return {
    version: 1,
    origin,
    orientationDeg: 0,
    parts,
    provenance: {
      origin: building.provenance,
      orientation: { source: 'default', confidence: 1, note: 'Plan north is true north.' },
      footprint: building.provenance,
      eaveHeight: height.provenance,
      roof: parts[0] !== undefined ? estimateRoof(building.tags, parts[0].footprint).provenance : height.provenance,
    },
    issues,
    label: building.label,
  };
}

/** Place several buildings in one local frame, keeping their positions relative to each other. */
export function assembleBuildings(buildings: readonly GeographicBuilding[]): HouseModel {
  const anchor = buildings[0]?.parts[0]?.outer[0];
  if (anchor === undefined) throw new Error('Those buildings had no usable outlines.');
  const drafted: {
    points: PlanPoint[];
    holes: PlanPoint[][];
    eaveHeightM: number;
    roof: HousePart['roof'];
    issues: string[];
    roofProvenance: Provenance;
    heightProvenance: Provenance;
  }[] = [];
  for (const building of buildings) {
    const height = estimateEaveHeight({
      osmHeight: building.tags.height,
      osmLevels: building.tags['building:levels'],
    });
    for (const part of building.parts) {
      const outer = cleanFootprint(projectRing(part.outer, anchor));
      if (outer.points.length < 3) continue;
      const holes = part.holes
        .map((hole) => cleanFootprint(projectRing(hole, anchor)))
        .filter((hole) => hole.points.length >= 3);
      const roof = estimateRoof(building.tags, outer.points);
      drafted.push({
        points: outer.points,
        holes: holes.map((hole) => hole.points),
        eaveHeightM: height.eaveHeightM,
        roof: roof.roof,
        issues: [...outer.issues, ...holes.flatMap((hole) => hole.issues), ...roof.issues],
        roofProvenance: roof.provenance,
        heightProvenance: height.provenance,
      });
    }
  }
  const first = drafted[0];
  if (first === undefined) throw new Error('Those buildings had no usable outlines.');
  let minEast = Infinity;
  let maxEast = -Infinity;
  let minNorth = Infinity;
  let maxNorth = -Infinity;
  for (const part of drafted) {
    for (const point of part.points) {
      minEast = Math.min(minEast, point.east);
      maxEast = Math.max(maxEast, point.east);
      minNorth = Math.min(minNorth, point.north);
      maxNorth = Math.max(maxNorth, point.north);
    }
  }
  const centroid = { east: (minEast + maxEast) / 2, north: (minNorth + maxNorth) / 2 };
  const count = buildings.length;
  return {
    version: 1,
    origin: localToLngLat(centroid, anchor),
    orientationDeg: 0,
    parts: drafted.map((part, index) => ({
      id: `building-${index + 1}`,
      footprint: shift(part.points, centroid),
      holes: part.holes.map((hole) => shift(hole, centroid)),
      eaveHeightM: part.eaveHeightM,
      roof: part.roof,
    })),
    provenance: {
      origin: { source: 'osm', confidence: 0.8, note: 'Center of the selected buildings.' },
      orientation: { source: 'default', confidence: 1, note: 'Plan north is true north.' },
      footprint: { source: 'osm', confidence: 0.8, note: `${count} building outlines from the map selection.` },
      eaveHeight: first.heightProvenance,
      roof: first.roofProvenance,
    },
    issues: drafted.flatMap((part) => part.issues).slice(0, 8),
    label: count === 1 ? (buildings[0]?.label ?? 'Building') : `${count} buildings`,
  };
}

/** Replace the main outline with a traced ring and recenter on it. Height and roof are kept. */
export function assembleTrace(vertices: readonly LngLat[], current: HouseModel): HouseModel {
  if (vertices.length < 3) return current;
  const anchor = vertices[0];
  if (anchor === undefined) return current;
  const projected = projectRing(vertices, anchor);
  const cleaned = cleanFootprint(projected);
  if (cleaned.points.length < 3) return current;
  const centroid = polygonCentroid(cleaned.points);
  const origin = localToLngLat(centroid, anchor);
  const footprint = shift(cleaned.points, centroid);
  const first = current.parts[0];
  if (first === undefined) return current;
  return {
    ...current,
    origin,
    parts: [{ ...first, footprint, holes: [] }],
    provenance: {
      ...current.provenance,
      origin: { source: 'user-trace', confidence: 0.9 },
      footprint: { source: 'user-trace', confidence: 0.9, note: 'Traced on the map.' },
    },
    issues: cleaned.issues,
    label: current.label,
  };
}

function shift(points: readonly PlanPoint[], centroid: PlanPoint): PlanPoint[] {
  return points.map((point) => ({ east: point.east - centroid.east, north: point.north - centroid.north }));
}

function polygonArea(points: readonly PlanPoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    if (current === undefined || next === undefined) continue;
    twice += current.east * next.north - next.east * current.north;
  }
  return twice / 2;
}
