/**
 * Fixed site for the milestone 1 scene.
 * These are the observer coordinates from the NREL Solar Position Algorithm sample
 * (Reda & Andreas, 2004): Golden, Colorado. Elevation is not passed to SunCalc.getPosition.
 */
export const DEMO_LOCATION = {
  name: 'Golden, Colorado',
  latitude: 39.742476,
  longitude: -105.1786,
  timeZone: 'America/Denver',
} as const;
