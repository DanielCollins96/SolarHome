/**
 * Fixed site for the milestone 1 scene.
 * These are the observer coordinates from the NREL Solar Position Algorithm sample
 * (Reda & Andreas, 2004): Golden, Colorado. Elevation is not passed to SunCalc.getPosition.
 */
export const DEMO_LOCATION = {
  name: 'Calgary, Alberta',
  latitude: 51.0447,
  longitude: -114.0719,
  timeZone: 'America/Edmonton',
} as const;
