import type { Provenance } from './houseModel.ts';

export interface HeightInput {
  userMeters?: number;
  lidarMeters?: number;
  /** Raw OSM `height` tag, for example "12", "12 m", or "40 ft". */
  osmHeight?: string;
  /** Raw OSM `roof:height`. The OSM `height` tag runs to the top of the roof, so this comes off it. */
  osmRoofHeight?: string;
  /** Raw OSM `building:levels` tag. */
  osmLevels?: string;
  shadowMeters?: number;
}

export interface HeightEstimate {
  eaveHeightM: number;
  provenance: Provenance;
}

const METERS_PER_LEVEL = 3;
const DEFAULT_EAVE_M = 6;

/**
 * First available source wins: typed value, LiDAR, OSM height, OSM levels × 3 m,
 * a shadow-length estimate, then a 6 m default.
 * OSM `height` is applied as the eave height. Where that tag means the ridge,
 * the walls run a little tall until someone overrides it.
 */
export function estimateEaveHeight(input: HeightInput): HeightEstimate {
  if (isPositive(input.userMeters)) {
    return { eaveHeightM: input.userMeters, provenance: { source: 'user', confidence: 1 } };
  }
  if (isPositive(input.lidarMeters)) {
    return {
      eaveHeightM: input.lidarMeters,
      provenance: { source: 'lidar', confidence: 0.8, note: 'No LiDAR source is connected yet.' },
    };
  }
  const osmHeight = parseLengthMeters(input.osmHeight);
  const osmRoofHeight = parseLengthMeters(input.osmRoofHeight);
  if (osmHeight !== undefined && osmRoofHeight !== undefined && osmRoofHeight <= osmHeight) {
    return {
      // A pyramid can be all roof. Keep a sliver of wall so the model stays valid.
      eaveHeightM: Math.max(osmHeight - osmRoofHeight, 0.1),
      provenance: {
        source: 'osm',
        confidence: 0.75,
        note: 'OpenStreetMap height less the roof height.',
      },
    };
  }
  if (osmHeight !== undefined) {
    return {
      eaveHeightM: osmHeight,
      provenance: {
        source: 'osm',
        confidence: 0.7,
        note: 'OpenStreetMap height, used as the eave height.',
      },
    };
  }
  const levels = parseLevels(input.osmLevels);
  if (levels !== undefined) {
    return {
      eaveHeightM: levels * METERS_PER_LEVEL,
      provenance: {
        source: 'osm',
        confidence: 0.45,
        note: `${formatLevels(levels)} levels × ${METERS_PER_LEVEL} m.`,
      },
    };
  }
  if (isPositive(input.shadowMeters)) {
    return {
      eaveHeightM: input.shadowMeters,
      provenance: { source: 'image', confidence: 0.4, note: 'Estimated from a shadow length.' },
    };
  }
  return {
    eaveHeightM: DEFAULT_EAVE_M,
    provenance: { source: 'default', confidence: 0.2, note: 'No height tag. Using 6 m.' },
  };
}

/**
 * Height of a part's underside above the ground: OSM `min_height`, else `building:min_level` × 3 m.
 * A tower's pod or a bridge between buildings starts in the air.
 */
export function estimateBaseHeight(tags: Record<string, string>): number {
  const minHeight = parseLengthMeters(tags.min_height);
  if (minHeight !== undefined) return minHeight;
  const minLevel = parseLevels(tags['building:min_level']);
  return minLevel === undefined ? 0 : minLevel * METERS_PER_LEVEL;
}

/** The part's height split into a base off the ground and walls above it. Walls keep a sliver so the part stays valid. */
export function stackedHeights(eaveAboveGroundM: number, baseM: number): { eaveHeightM: number; baseHeightM?: number } {
  if (baseM <= 0) return { eaveHeightM: eaveAboveGroundM };
  return { eaveHeightM: Math.max(eaveAboveGroundM - baseM, 0.1), baseHeightM: baseM };
}

/** Parse an OSM length. Feet are converted with 0.3048 m/ft. Unknown units are rejected. */
export function parseLengthMeters(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)\s*([a-z']+)?$/.exec(raw.trim().toLowerCase().replace(/,/g, '.'));
  if (match === null) return undefined;
  const magnitude = Number(match[1]);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return undefined;
  const unit = match[2] ?? 'm';
  if (unit === 'm' || unit === 'meter' || unit === 'meters' || unit === 'metre' || unit === 'metres') {
    return magnitude;
  }
  if (unit === 'ft' || unit === 'feet' || unit === 'foot' || unit === "'") return magnitude * 0.3048;
  return undefined;
}

function parseLevels(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim())) return undefined;
  const levels = Number(raw);
  if (!Number.isFinite(levels) || levels <= 0) return undefined;
  return levels;
}

function formatLevels(levels: number): string {
  return Number.isInteger(levels) ? String(levels) : levels.toFixed(1);
}

function isPositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
