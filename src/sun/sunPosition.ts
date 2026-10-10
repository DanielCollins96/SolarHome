import * as SunCalc from 'suncalc';
import { dateAtFixedOffset, minutesInZone, parseISODate, timeZoneOffsetMinutes, zonedLocalToDate } from './zonedTime.ts';

/** Unit vector toward the sun. X = east, Y = up, Z = south. */
export interface SunVector {
  x: number;
  y: number;
  z: number;
}

export interface SunDirection extends SunVector {
  /** Apparent altitude above the horizon, degrees. Negative when the sun is down. */
  altitudeDeg: number;
  /** Clockwise from true north, degrees. 0 = N, 90 = E, 180 = S, 270 = W. */
  azimuthDeg: number;
}

/**
 * Map a horizontal sun position into the scene frame.
 *
 * SunCalc 2 reports azimuth in degrees, clockwise from north, and altitude in degrees.
 * North is -Z and east is +X, so:
 *   x =  sin(azimuth) * cos(altitude)
 *   y =  sin(altitude)
 *   z = -cos(azimuth) * cos(altitude)
 */
export function directionTowardSun(azimuthDeg: number, altitudeDeg: number): SunVector {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const altitude = (altitudeDeg * Math.PI) / 180;
  const cosAltitude = Math.cos(altitude);
  return {
    x: Math.sin(azimuth) * cosAltitude,
    y: Math.sin(altitude),
    z: -Math.cos(azimuth) * cosAltitude,
  };
}

export function sunDirection(date: Date, latitude: number, longitude: number): SunDirection {
  const position = SunCalc.getPosition(date, latitude, longitude);
  return {
    ...directionTowardSun(position.azimuth, position.altitude),
    altitudeDeg: position.altitude,
    azimuthDeg: position.azimuth,
  };
}

/**
 * Horizontal direction the shadow falls, opposite the sun's east/south components.
 * Null when the sun is effectively overhead and casts no horizontal shadow.
 * X = east, Z = south, so a shadow that points north has z < 0.
 */
export function shadowFallDirection(towardSun: SunVector): { x: number; z: number } | null {
  const horizontal = Math.hypot(towardSun.x, towardSun.z);
  if (horizontal < 1e-6) return null;
  return { x: -towardSun.x / horizontal, z: -towardSun.z / horizontal };
}

const SHADOW_CARDINALS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

export function shadowCardinalLabel(shadow: { x: number; z: number } | null): string {
  if (shadow === null) return 'overhead';
  const bearing = (Math.atan2(shadow.x, -shadow.z) * 180) / Math.PI;
  const wrapped = (bearing + 360) % 360;
  const index = Math.round(wrapped / 45) % 8;
  return SHADOW_CARDINALS[index] ?? 'north';
}

/** Local minutes since midnight of solar noon for the civil date at this site. */
export function solarNoonLocalMinutes(
  isoDate: string,
  latitude: number,
  longitude: number,
  timeZone: string,
): number {
  const { year, month, day } = parseISODate(isoDate);
  const midday = zonedLocalToDate(year, month, day, 12, 0, timeZone);
  const offset = timeZoneOffsetMinutes(midday, timeZone);
  const times = SunCalc.getTimes(midday, latitude, longitude, 0, offset);
  return minutesInZone(times.solarNoon, timeZone);
}

/** Solar noon as minutes since midnight in a fixed longitude offset, without daylight saving. */
export function solarNoonMinutesAtOffset(
  isoDate: string,
  latitude: number,
  longitude: number,
  offsetMinutes: number,
): number {
  const { year, month, day } = parseISODate(isoDate);
  const midday = dateAtFixedOffset(year, month, day, 12, 0, offsetMinutes);
  const times = SunCalc.getTimes(midday, latitude, longitude, 0, offsetMinutes);
  const local = new Date(times.solarNoon.getTime() + offsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}
