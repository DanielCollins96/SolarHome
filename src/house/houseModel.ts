import type { PlanPoint } from './centering.ts';
import { signedArea } from './planGeometry.ts';

export const HOUSE_MODEL_VERSION = 1;

export type ProvenanceSource = 'osm' | 'user-trace' | 'user' | 'image' | 'lidar' | 'default';

export interface Provenance {
  source: ProvenanceSource;
  /** 0 is a guess, 1 is something the user typed or measured. */
  confidence: number;
  note?: string;
}

export type RoofType = 'flat' | 'shed' | 'gable' | 'hip';

export interface RoofSpec {
  type: RoofType;
  /**
   * Clockwise degrees from true north.
   * Gable and hip: the ridge direction.
   * Shed: the downhill direction, from ridge toward eaves.
   */
  directionDeg: number;
  pitchDeg: number;
  overhangM: number;
}

export interface HousePart {
  id: string;
  /** Counter-clockwise outer ring in local east/north metres, centroid at the origin. */
  footprint: PlanPoint[];
  /** Holes are counter-clockwise, same convention as the outer ring. */
  holes: PlanPoint[][];
  eaveHeightM: number;
  roof: RoofSpec;
}

export interface HouseModel {
  version: typeof HOUSE_MODEL_VERSION;
  origin: { latitude: number; longitude: number };
  /** Clockwise degrees from true north. 0 keeps plan-north aligned with true north. */
  orientationDeg: number;
  parts: HousePart[];
  provenance: {
    origin: Provenance;
    orientation: Provenance;
    footprint: Provenance;
    eaveHeight: Provenance;
    roof: Provenance;
  };
  issues: string[];
  label: string;
}

export function houseFootprintArea(model: HouseModel): number {
  return model.parts.reduce((total, part) => {
    const holes = part.holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
    return total + Math.abs(signedArea(part.footprint)) - holes;
  }, 0);
}

export function exportHouseJson(model: HouseModel): string {
  return JSON.stringify(model, null, 2);
}

export function importHouseJson(raw: string): HouseModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('This file is not a SolarHome house model.');
  }
  return coerceHouseModel(parsed);
}

export function withEaveHeight(model: HouseModel, eaveHeightM: number): HouseModel {
  return {
    ...model,
    parts: model.parts.map((part) => ({ ...part, eaveHeightM })),
    provenance: { ...model.provenance, eaveHeight: { source: 'user', confidence: 1 } },
  };
}

export function withRoof(model: HouseModel, roof: RoofSpec): HouseModel {
  return {
    ...model,
    parts: model.parts.map((part) => ({ ...part, roof: { ...roof } })),
    provenance: { ...model.provenance, roof: { source: 'user', confidence: 1 } },
  };
}

export function withOrientation(model: HouseModel, orientationDeg: number): HouseModel {
  return {
    ...model,
    orientationDeg,
    provenance: { ...model.provenance, orientation: { source: 'user', confidence: 1 } },
  };
}

export function withFootprint(
  model: HouseModel,
  footprint: PlanPoint[],
  holes: PlanPoint[][],
  provenance: Provenance,
  issues: string[],
): HouseModel {
  const [first, ...rest] = model.parts;
  if (first === undefined) throw new Error('The house has no parts to edit.');
  return {
    ...model,
    parts: [{ ...first, footprint, holes }, ...rest],
    provenance: { ...model.provenance, footprint: provenance },
    issues,
  };
}

function coerceHouseModel(value: unknown): HouseModel {
  if (!isRecord(value) || value.version !== HOUSE_MODEL_VERSION) {
    throw new Error('This file is not a SolarHome house model.');
  }
  const origin = value.origin;
  if (!isRecord(origin) || !isFiniteNumber(origin.latitude) || !isFiniteNumber(origin.longitude)) {
    throw new Error('The house file is missing its latitude and longitude.');
  }
  if (!isFiniteNumber(value.orientationDeg)) throw new Error('The house file has a bad orientation.');
  if (!Array.isArray(value.parts) || value.parts.length === 0) {
    throw new Error('The house file has no parts.');
  }
  return {
    version: HOUSE_MODEL_VERSION,
    origin: { latitude: origin.latitude, longitude: origin.longitude },
    orientationDeg: value.orientationDeg,
    parts: value.parts.map((part, index) => coercePart(part, index)),
    provenance: coerceProvenanceBlock(value.provenance),
    issues: Array.isArray(value.issues) ? value.issues.filter((item) => typeof item === 'string') : [],
    label: typeof value.label === 'string' ? value.label : 'Imported house',
  };
}

function coercePart(value: unknown, index: number): HousePart {
  if (!isRecord(value)) throw new Error(`Part ${index + 1} is not an object.`);
  const footprint = coerceRing(value.footprint, `Part ${index + 1}`);
  const holes = Array.isArray(value.holes) ? value.holes.map((hole, holeIndex) => coerceRing(hole, `Hole ${holeIndex + 1}`)) : [];
  if (!isFiniteNumber(value.eaveHeightM) || value.eaveHeightM <= 0) {
    throw new Error(`Part ${index + 1} needs a positive eave height.`);
  }
  return {
    id: typeof value.id === 'string' ? value.id : `part-${index + 1}`,
    footprint,
    holes,
    eaveHeightM: value.eaveHeightM,
    roof: coerceRoof(value.roof),
  };
}

function coerceRoof(value: unknown): RoofSpec {
  if (!isRecord(value) || !isRoofType(value.type)) throw new Error('The house file has a bad roof.');
  if (!isFiniteNumber(value.directionDeg) || !isFiniteNumber(value.pitchDeg) || !isFiniteNumber(value.overhangM)) {
    throw new Error('The house file has a bad roof.');
  }
  if (value.pitchDeg < 0 || value.pitchDeg >= 89) throw new Error('Roof pitch must be between 0 and 89 degrees.');
  if (value.overhangM < 0) throw new Error('Roof overhang cannot be negative.');
  return {
    type: value.type,
    directionDeg: value.directionDeg,
    pitchDeg: value.type === 'flat' ? 0 : value.pitchDeg,
    overhangM: value.overhangM,
  };
}

function coerceRing(value: unknown, label: string): PlanPoint[] {
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${label} needs at least 3 corners.`);
  return value.map((point) => {
    if (!isRecord(point) || !isFiniteNumber(point.east) || !isFiniteNumber(point.north)) {
      throw new Error(`${label} has a corner that is not a coordinate.`);
    }
    return { east: point.east, north: point.north };
  });
}

function coerceProvenanceBlock(value: unknown): HouseModel['provenance'] {
  const record = isRecord(value) ? value : {};
  return {
    origin: coerceProvenance(record.origin),
    orientation: coerceProvenance(record.orientation),
    footprint: coerceProvenance(record.footprint),
    eaveHeight: coerceProvenance(record.eaveHeight),
    roof: coerceProvenance(record.roof),
  };
}

function coerceProvenance(value: unknown): Provenance {
  if (!isRecord(value) || !isSource(value.source) || !isFiniteNumber(value.confidence)) {
    return { source: 'default', confidence: 0.2 };
  }
  return {
    source: value.source,
    confidence: Math.min(1, Math.max(0, value.confidence)),
    note: typeof value.note === 'string' ? value.note : undefined,
  };
}

function isRoofType(value: unknown): value is RoofType {
  return value === 'flat' || value === 'shed' || value === 'gable' || value === 'hip';
}

function isSource(value: unknown): value is ProvenanceSource {
  return (
    value === 'osm' ||
    value === 'user-trace' ||
    value === 'user' ||
    value === 'image' ||
    value === 'lidar' ||
    value === 'default'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
