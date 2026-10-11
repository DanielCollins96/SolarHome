import tzLookup from '@photostructure/tz-lookup';

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function parseISODate(iso: string): CivilDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Expected YYYY-MM-DD, received "${iso}".`);
  }
  return { year: Number(year), month: Number(month), day: Number(day) };
}

/**
 * Minutes to add to UTC to get civil time in `timeZone`.
 * Positive east of Greenwich. America/Denver is -360 in summer and -420 in winter.
 */
export function timeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = readZonedParts(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Convert a civil date and clock time in `timeZone` to an absolute instant. */
export function zonedLocalToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(wallAsUtc);
  // Two passes cover the one-hour DST shift between the first guess and the real instant.
  for (let pass = 0; pass < 2; pass++) {
    const offset = timeZoneOffsetMinutes(guess, timeZone);
    guess = new Date(wallAsUtc - offset * 60_000);
  }
  return guess;
}

/** Minutes since local midnight for an instant, in `timeZone`. */
export function minutesInZone(instant: Date, timeZone: string): number {
  const parts = readZonedParts(instant, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** Whole-hour offset east of UTC, from longitude. This ignores daylight saving. */
export function longitudeOffsetMinutes(longitude: number): number {
  return Math.round(longitude / 15) * 60;
}

export function dateAtFixedOffset(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetMinutes: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMinutes * 60_000);
}

export function formatMinutes(minutes: number): string {
  const clamped = Math.min(1439, Math.max(0, Math.round(minutes)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function readZonedParts(instant: Date, timeZone: string): ZonedParts {
  const listed = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value: Record<string, string> = {};
  for (const part of listed) {
    if (part.type !== 'literal') value[part.type] = part.value;
  }

  const year = Number(value.year);
  const month = Number(value.month);
  const day = Number(value.day);
  let hour = Number(value.hour);
  const minute = Number(value.minute);
  const second = Number(value.second);
  // A few engines report midnight as 24:00 on the date that is ending.
  if (hour === 24) hour = 0;

  if ([year, month, day, hour, minute, second].some((part) => Number.isNaN(part))) {
    throw new Error(`Could not read civil time in ${timeZone}.`);
  }

  return { year, month, day, hour, minute, second };
}

/**
 * The IANA time zone at a place, such as America/Edmonton for Calgary, so clock times follow
 * local daylight saving. Null when the place has no zone this browser can use.
 */
export function timeZoneAt(latitude: number, longitude: number): string | null {
  try {
    const zone = tzLookup(latitude, longitude);
    // Throws when the browser does not know the zone.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}
