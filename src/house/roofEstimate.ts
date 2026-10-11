import { polygonCentroid, type PlanPoint } from './centering.ts';
import { parseLengthMeters } from './heightEstimate.ts';
import type { Provenance, RoofSpec, RoofType } from './houseModel.ts';
import { distance, largestInset, signedArea } from './planGeometry.ts';

export interface RoofEstimate {
  roof: RoofSpec;
  provenance: Provenance;
  issues: string[];
}

const DEFAULT_PITCH_DEG = 25;
/**
 * Above this footprint an untagged roof is guessed flat. A 25° house gable across a building
 * 100 m wide would add a 20 m roof that almost never exists on offices, malls, or warehouses.
 */
const LARGE_FOOTPRINT_M2 = 600;

/**
 * Map OSM roof tags onto flat, shed, gable, or hip.
 * `roof:direction` is the downhill compass bearing (ridge toward eaves).
 * `roof:orientation` of along/across is the ridge relative to the longest wall.
 * With neither tag, a ridge roof follows the longest wall.
 */
export function estimateRoof(tags: Record<string, string>, footprint: readonly PlanPoint[]): RoofEstimate {
  const issues: string[] = [];
  const shape = tags['roof:shape']?.trim().toLowerCase();
  // A building part without a roof shape is flat, by the OSM 3D convention. Parts stack, like
  // a tower's shaft under its pod, so a guessed gable would poke up between them.
  // Towers get the same treatment: a house gable across a round top makes no sense.
  const part = tags['building:part'];
  const isPart = part !== undefined && part !== '' && part !== 'no';
  const isTower = tags.man_made === 'tower' || tags['building:shape'] === 'tower' || tags.building === 'tower';
  const untaggedPart = (shape === undefined || shape === '') && (isPart || isTower);
  const type = untaggedPart ? 'flat' : roofTypeFromShape(shape);
  const overhang = 0;
  const direction = directionFromTags(tags, footprint, type, issues);
  const pitch = pitchFromTags(tags, type, footprint, direction.degrees);
  const knownShape = type !== null;
  const large = Math.abs(signedArea([...footprint])) > LARGE_FOOTPRINT_M2;
  const resolved: RoofType = type ?? (large ? 'flat' : 'gable');
  if (shape !== undefined && !knownShape) {
    issues.push(`Roof shape "${shape}" is not one of the four presets, so this is ${resolved === 'flat' ? 'flat' : 'a gable'}.`);
  }
  return {
    roof: {
      type: resolved,
      directionDeg: direction.degrees,
      pitchDeg: resolved === 'flat' ? 0 : pitch.degrees,
      overhangM: overhang,
    },
    provenance: {
      source: knownShape || pitch.source === 'osm' || direction.source === 'osm' ? 'osm' : 'default',
      confidence: untaggedPart ? 0.5 : knownShape ? 0.75 : 0.3,
      note: untaggedPart
        ? 'Building part or tower with no roof shape tag. Flat, as OSM 3D buildings assume.'
        : knownShape
          ? undefined
          : large
            ? 'No roof shape tag. A building this large is drawn flat.'
            : 'No roof shape tag. Using a 25° gable along the longest wall.',
    },
    issues,
  };
}

function roofTypeFromShape(shape: string | undefined): RoofType | null {
  if (shape === undefined || shape === '') return null;
  if (shape === 'flat') return 'flat';
  if (shape === 'skillion' || shape === 'shed' || shape === 'pent' || shape === 'lean_to') return 'shed';
  if (shape === 'gabled' || shape === 'gable' || shape === 'gambrel') return 'gable';
  if (shape === 'hipped' || shape === 'hip' || shape === 'pyramidal' || shape === 'half-hipped') return 'hip';
  // Round roofs rise to a point too, so a hip is the nearest of the four presets.
  if (shape === 'dome' || shape === 'cone' || shape === 'onion') return 'hip';
  return null;
}

function pitchFromTags(
  tags: Record<string, string>,
  type: RoofType | null,
  footprint: readonly PlanPoint[],
  directionDeg: number,
): { degrees: number; source: 'osm' | 'default' } {
  if (type === 'flat') return { degrees: 0, source: 'osm' };
  const raw = tags['roof:angle'];
  if (raw !== undefined && /^\d+(?:\.\d+)?$/.test(raw.trim())) {
    const degrees = Number(raw);
    if (degrees >= 0 && degrees < 89) return { degrees, source: 'osm' };
  }
  // A roof height fixes the slope once we know how far the roof runs from eave to peak.
  const rise = parseLengthMeters(tags['roof:height']);
  const run = rise === undefined ? 0 : roofRun(type ?? 'gable', footprint, directionDeg);
  if (rise !== undefined && run > 0) {
    return { degrees: Math.min(88, (Math.atan(rise / run) * 180) / Math.PI), source: 'osm' };
  }
  return { degrees: DEFAULT_PITCH_DEG, source: 'default' };
}

/** Horizontal distance from eave to peak, measured the way the roof mesh is built. */
function roofRun(type: RoofType, footprint: readonly PlanPoint[], directionDeg: number): number {
  if (type === 'hip') return largestInset(footprint)?.distance ?? 0;
  const radians = (directionDeg * Math.PI) / 180;
  const along = { east: Math.sin(radians), north: Math.cos(radians) };
  if (type === 'shed') {
    const reach = footprint.map((point) => point.east * along.east + point.north * along.north);
    return Math.max(...reach) - Math.min(...reach);
  }
  // Gable: from the ridge through the centroid out to the farthest eave.
  const center = polygonCentroid([...footprint]);
  return Math.max(
    ...footprint.map((point) => Math.abs((point.east - center.east) * -along.north + (point.north - center.north) * along.east)),
  );
}

function directionFromTags(
  tags: Record<string, string>,
  footprint: readonly PlanPoint[],
  type: RoofType | null,
  issues: string[],
): { degrees: number; source: 'osm' | 'default' } {
  const longest = longestEdgeAzimuth(footprint);
  const downhill = parseCompass(tags['roof:direction']);
  if (downhill !== undefined) {
    if (type === 'shed') return { degrees: downhill, source: 'osm' };
    return { degrees: wrap(downhill + 90), source: 'osm' };
  }
  const orientation = tags['roof:orientation']?.trim().toLowerCase();
  if (orientation === 'along') return { degrees: longest, source: 'osm' };
  if (orientation === 'across') return { degrees: wrap(longest + 90), source: 'osm' };
  if (orientation !== undefined && orientation !== '') {
    issues.push(`Roof orientation "${orientation}" was not understood. The ridge follows the longest wall.`);
  }
  if (type === 'shed') return { degrees: 180, source: 'default' };
  return { degrees: longest, source: 'default' };
}

export function parseCompass(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const degrees = Number(text);
    if (degrees >= 0 && degrees < 360) return degrees;
    return undefined;
  }
  return COMPASS[text];
}

const COMPASS: Record<string, number> = {
  n: 0,
  nne: 22.5,
  ne: 45,
  ene: 67.5,
  e: 90,
  ese: 112.5,
  se: 135,
  sse: 157.5,
  s: 180,
  ssw: 202.5,
  sw: 225,
  wsw: 247.5,
  w: 270,
  wnw: 292.5,
  nw: 315,
  nnw: 337.5,
};

export function longestEdgeAzimuth(footprint: readonly PlanPoint[]): number {
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i < footprint.length; i++) {
    const start = footprint[i];
    const end = footprint[(i + 1) % footprint.length];
    if (start === undefined || end === undefined) continue;
    const length = distance(start, end);
    if (length > bestLength) {
      bestLength = length;
      best = (Math.atan2(end.east - start.east, end.north - start.north) * 180) / Math.PI;
    }
  }
  return wrap(best);
}

function wrap(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}
