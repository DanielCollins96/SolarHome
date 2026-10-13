import { describe, expect, it } from 'vitest';
import { createLookupCache } from '../src/geo/cache.ts';
import { skySamples } from '../src/solar/exposure.ts';
import { applyWeather, loadMonthlyWeather, monthlyFromPvgis } from '../src/solar/weather.ts';

/** Two years of PVGIS MRcalc rows, darker in winter. */
function pvgisBody(scale = 1): unknown {
  const monthly = [2005, 2006].flatMap((year) =>
    Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1, 'H(h)_m': (40 + 150 * Math.sin((Math.PI * (i + 0.5)) / 12)) * scale * (year === 2005 ? 0.9 : 1.1), Kd: 0.4 })),
  );
  return { inputs: {}, outputs: { monthly } };
}

describe('PVGIS monthly weather', () => {
  it('averages each month over the years', () => {
    const weather = monthlyFromPvgis(pvgisBody(), 'PVGIS-NSRDB');
    expect(weather.firstYear).toBe(2005);
    expect(weather.lastYear).toBe(2006);
    expect(weather.ghi[0]).toBeCloseTo(40 + 150 * Math.sin(Math.PI / 24), 6);
    expect(weather.diffuseShare[6]).toBeCloseTo(0.4, 6);
  });

  it('dims the cloudless year so each month matches the record on level ground', () => {
    const clear = skySamples(51.04, -114.06, 2026);
    // A record at 70% of the cloudless months, with 40% of it from the sky.
    const clearMonths = new Array<number>(12).fill(0);
    for (let i = 0; i < clear.hours.length; i++) {
      const month = clear.month[i] ?? 0;
      clearMonths[month] = (clearMonths[month] ?? 0) + ((clear.ghi[i] ?? 0) * (clear.hours[i] ?? 0)) / 1000;
    }
    const monthly = clearMonths.map((kwh, i) => ({ year: 2010, month: i + 1, 'H(h)_m': kwh * 0.7, Kd: 0.4 }));
    const weather = monthlyFromPvgis({ outputs: { monthly } }, 'PVGIS-NSRDB');
    const sky = applyWeather(clear, weather);
    for (let month = 0; month < 12; month++) {
      let total = 0;
      let diffuse = 0;
      for (let i = 0; i < sky.hours.length; i++) {
        if (sky.month[i] !== month) continue;
        total += (sky.ghi[i] ?? 0) * (sky.hours[i] ?? 0);
        diffuse += (sky.dhi[i] ?? 0) * (sky.hours[i] ?? 0);
      }
      expect(total / 1000).toBeCloseTo(weather.ghi[month] ?? 0, 0);
      expect(diffuse / total).toBeCloseTo(0.4, 2);
    }
  });

  it('falls back to ERA5 outside NSRDB, and caches the answer', async () => {
    const asked: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      asked.push(url.searchParams.get('raddatabase') ?? '');
      if (url.searchParams.get('raddatabase') === 'PVGIS-NSRDB') return new Response('{"message":"out of coverage"}', { status: 400 });
      return new Response(JSON.stringify(pvgisBody()), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const cache = createLookupCache();
    const first = await loadMonthlyWeather(64.5, -114, { fetch: fetchStub, cache });
    expect(first.source).toBe('PVGIS-ERA5');
    expect(asked).toEqual(['PVGIS-NSRDB', 'PVGIS-ERA5']);
    const again = await loadMonthlyWeather(64.501, -114.001, { fetch: fetchStub, cache });
    expect(again.ghi).toEqual(first.ghi);
    expect(asked).toHaveLength(2);
  });
});
