import { centerPolygon } from './centering.ts';
import { demoFootprint } from './houseMesh.ts';
import type { HouseModel } from './houseModel.ts';
import { DEMO_LOCATION } from '../scene/demoLocation.ts';

const shared = { source: 'default' as const, confidence: 0.3 };

/** The milestone 1 house, expressed as the shared house model. */
export function demoHouseModel(): HouseModel {
  return {
    version: 1,
    origin: { latitude: DEMO_LOCATION.latitude, longitude: DEMO_LOCATION.longitude },
    orientationDeg: 0,
    parts: [
      {
        id: 'demo',
        footprint: centerPolygon(demoFootprint()).points,
        holes: [],
        eaveHeightM: 3,
        roof: { type: 'gable', directionDeg: 90, pitchDeg: 30, overhangM: 0 },
      },
    ],
    provenance: {
      origin: { source: 'default', confidence: 1, note: DEMO_LOCATION.name },
      orientation: { source: 'default', confidence: 1, note: 'Plan north is true north.' },
      footprint: { ...shared, note: 'Hardcoded rectangle, not a surveyed building.' },
      eaveHeight: { ...shared, note: 'Illustrative 3 m eaves.' },
      roof: { ...shared, note: 'Illustrative 30° gable.' },
    },
    issues: [],
    label: 'Demonstration house',
  };
}
