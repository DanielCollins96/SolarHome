import { describe, expect, it } from 'vitest';
import {
  directionTowardSun,
  shadowCardinalLabel,
  shadowFallDirection,
  solarNoonLocalMinutes,
  sunDirection,
} from '../src/sun/sunPosition.ts';

/**
 * NREL Solar Position Algorithm sample (Reda & Andreas, NREL/TP-560-34302).
 * Observer: 39.742476°N, 105.1786°W. Local time 2003-10-17 12:30:30, timezone -7.
 * Published topocentric azimuth 194.34024° (clockwise from north) and zenith 50.11162°.
 */
const NREL_LATITUDE = 39.742476;
const NREL_LONGITUDE = -105.1786;
const NREL_TIME_ZONE = 'America/Denver';
const NREL_AZIMUTH_DEG = 194.34024;
const NREL_ALTITUDE_DEG = 90 - 50.11162;
const NREL_INSTANT = new Date(Date.UTC(2003, 9, 17, 19, 30, 30));

describe('sun direction in the scene frame', () => {
  it('maps the cardinal directions onto east, up, and south', () => {
    const north = directionTowardSun(0, 0);
    expect(north.x).toBeCloseTo(0, 6);
    expect(north.y).toBeCloseTo(0, 6);
    expect(north.z).toBeCloseTo(-1, 6);

    const east = directionTowardSun(90, 0);
    expect(east.x).toBeCloseTo(1, 6);
    expect(east.z).toBeCloseTo(0, 6);

    const south = directionTowardSun(180, 45);
    expect(south.x).toBeCloseTo(0, 6);
    expect(south.y).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(south.z).toBeCloseTo(Math.cos(Math.PI / 4), 6);

    const west = directionTowardSun(270, 0);
    expect(west.x).toBeCloseTo(-1, 6);
    expect(west.z).toBeCloseTo(0, 6);
  });

  it('matches the NREL sample angles and the published scene vector', () => {
    const sun = sunDirection(NREL_INSTANT, NREL_LATITUDE, NREL_LONGITUDE);
    expect(sun.azimuthDeg).toBeCloseTo(NREL_AZIMUTH_DEG, 1);
    expect(sun.altitudeDeg).toBeCloseTo(NREL_ALTITUDE_DEG, 1);

    const towardSun = directionTowardSun(NREL_AZIMUTH_DEG, NREL_ALTITUDE_DEG);
    expect(towardSun.x).toBeCloseTo(-0.19004330680843717, 5);
    expect(towardSun.y).toBeCloseTo(0.6412940317168584, 5);
    expect(towardSun.z).toBeCloseTo(0.7433878573272845, 5);
    expect(Math.hypot(towardSun.x, towardSun.y, towardSun.z)).toBeCloseTo(1, 6);
  });

  it('points the solar-noon shadow north at Golden', () => {
    const minutes = solarNoonLocalMinutes('2026-06-21', NREL_LATITUDE, NREL_LONGITUDE, NREL_TIME_ZONE);
    expect(minutes).toBeGreaterThan(13 * 60);
    expect(minutes).toBeLessThan(13 * 60 + 10);

    const sun = sunDirection(
      new Date(Date.UTC(2026, 5, 21, 19, 2, 37)),
      NREL_LATITUDE,
      NREL_LONGITUDE,
    );
    expect(sun.azimuthDeg).toBeCloseTo(180, 1);
    expect(sun.y).toBeGreaterThan(0);
    expect(sun.z).toBeGreaterThan(0);

    const shadow = shadowFallDirection(sun);
    expect(shadow).not.toBeNull();
    expect(shadow && shadow.z).toBeLessThan(-0.99);
    expect(shadow && Math.abs(shadow.x)).toBeLessThan(0.02);
    expect(shadowCardinalLabel(shadow)).toBe('north');
  });
});
