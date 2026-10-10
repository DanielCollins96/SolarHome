import { describe, expect, it } from 'vitest';
import { timeZoneOffsetMinutes, zonedLocalToDate } from '../src/sun/zonedTime.ts';

describe('site civil time', () => {
  it('maps a winter afternoon in Denver to UTC-7', () => {
    const instant = zonedLocalToDate(2026, 1, 15, 12, 0, 'America/Denver');
    expect(instant.toISOString()).toBe('2026-01-15T19:00:00.000Z');
    expect(timeZoneOffsetMinutes(instant, 'America/Denver')).toBe(-420);
  });

  it('maps a summer afternoon in Denver to UTC-6', () => {
    const instant = zonedLocalToDate(2026, 6, 21, 12, 0, 'America/Denver');
    expect(instant.toISOString()).toBe('2026-06-21T18:00:00.000Z');
    expect(timeZoneOffsetMinutes(instant, 'America/Denver')).toBe(-360);
  });
});
