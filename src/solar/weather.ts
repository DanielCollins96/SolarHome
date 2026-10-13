import type { LookupCache } from '../geo/cache.ts';
import { sendRequest } from '../geo/request.ts';
import { sameOrigin } from '../geo/sameOrigin.ts';
import type { SkySamples } from './exposure.ts';

/**
 * A place's average month of sunlight, measured rather than cloudless: PVGIS monthly totals on
 * level ground, and the share of them that came from the sky rather than straight from the sun.
 */
export interface MonthlyWeather {
  /** The PVGIS radiation database, such as PVGIS-NSRDB. */
  source: string;
  firstYear: number;
  lastYear: number;
  /** Twelve months, January first. kWh/m² on level ground over the whole month. */
  ghi: number[];
  /** Twelve months. The diffuse share of `ghi`, 0 to 1. */
  diffuseShare: number[];
}

export interface WeatherDeps {
  fetch: typeof fetch;
  cache: LookupCache;
  signal?: AbortSignal;
}

/**
 * Satellite-derived NSRDB covers the Americas and is the better record there. ERA5, a weather
 * model, covers most of the world and stands in elsewhere.
 */
const DATABASES = ['PVGIS-NSRDB', 'PVGIS-ERA5'] as const;
/**
 * Weather does not change within a couple of kilometres, so nearby houses share a cached lookup.
 * PVGIS is still asked about the house itself: a snapped point can land in a harbour, which it refuses.
 */
const CACHE_GRID_DEG = 0.02;
const CACHE_VERSION = 1;
/**
 * Bounds on the monthly scaling. A month of overcast can leave almost no direct beam; cloud
 * can lift the diffuse light several times above a clear sky's. Past these, the data is suspect.
 */
const MAX_BEAM_SCALE = 1.3;
const MAX_DIFFUSE_SCALE = 5;

/** Monthly sunlight for a place from PVGIS, through this site's proxy. Cached by place. */
export async function loadMonthlyWeather(latitude: number, longitude: number, deps: WeatherDeps): Promise<MonthlyWeather> {
  const key = `pvgis-monthly:v${CACHE_VERSION}:${snap(latitude)},${snap(longitude)}`;
  const lat = latitude.toFixed(4);
  const lon = longitude.toFixed(4);
  const cached = await deps.cache.get(key).catch(() => undefined);
  if (cached !== undefined) {
    const weather = parseStored(cached);
    if (weather !== null) return weather;
  }
  let lastError: unknown = null;
  for (const database of DATABASES) {
    const url = sameOrigin('/api/pvgis/MRcalc');
    url.search = new URLSearchParams({ lat, lon, horirrad: '1', d2g: '1', raddatabase: database, outputformat: 'json' }).toString();
    try {
      const response = await sendRequest(deps.fetch, url, { headers: { Accept: 'application/json' }, signal: deps.signal });
      // PVGIS answers 400 for a place outside the database's coverage, so the next one is tried.
      if (!response.ok) {
        lastError = new Error(`PVGIS answered ${response.status} for ${database}.`);
        continue;
      }
      const weather = monthlyFromPvgis(await response.json(), database);
      await deps.cache.set(key, JSON.stringify(weather)).catch(() => undefined);
      return weather;
    } catch (error) {
      if (deps.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('PVGIS did not answer.');
}

/** Average each calendar month over the years PVGIS returns. */
export function monthlyFromPvgis(body: unknown, database: string): MonthlyWeather {
  const rows = (body as { outputs?: { monthly?: unknown } }).outputs?.monthly;
  if (!Array.isArray(rows)) throw new Error('PVGIS sent no monthly data.');
  const ghiSum = new Array<number>(12).fill(0);
  const diffuseSum = new Array<number>(12).fill(0);
  const counts = new Array<number>(12).fill(0);
  let firstYear = Infinity;
  let lastYear = -Infinity;
  for (const row of rows as Record<string, unknown>[]) {
    const month = Number(row.month) - 1;
    const ghi = Number(row['H(h)_m']);
    const share = Number(row.Kd);
    const year = Number(row.year);
    if (!(month >= 0 && month < 12) || !Number.isFinite(ghi) || !Number.isFinite(share)) continue;
    ghiSum[month] = (ghiSum[month] ?? 0) + ghi;
    diffuseSum[month] = (diffuseSum[month] ?? 0) + ghi * share;
    counts[month] = (counts[month] ?? 0) + 1;
    if (Number.isFinite(year)) {
      firstYear = Math.min(firstYear, year);
      lastYear = Math.max(lastYear, year);
    }
  }
  if (counts.some((count) => count === 0)) throw new Error('PVGIS left out some months.');
  const ghi = ghiSum.map((sum, month) => sum / (counts[month] ?? 1));
  const diffuseShare = diffuseSum.map((sum, month) => ((ghiSum[month] ?? 0) > 0 ? sum / (ghiSum[month] ?? 1) : 1));
  return { source: database, firstYear, lastYear, ghi, diffuseShare };
}

/**
 * The cloudless year, dimmed to the place's measured months. Within a month, every sample's
 * direct beam is scaled by one factor and its sky light by another, so the month's totals on
 * level ground match the record while the sun keeps its real path for the shadows.
 */
export function applyWeather(sky: SkySamples, weather: MonthlyWeather): SkySamples {
  const clearBeam = new Array<number>(12).fill(0);
  const clearDiffuse = new Array<number>(12).fill(0);
  for (let i = 0; i < sky.hours.length; i++) {
    const month = sky.month[i] ?? 0;
    const hours = sky.hours[i] ?? 0;
    clearBeam[month] = (clearBeam[month] ?? 0) + (sky.dni[i] ?? 0) * Math.max(0, sky.toward[i * 3 + 1] ?? 0) * hours;
    clearDiffuse[month] = (clearDiffuse[month] ?? 0) + (sky.dhi[i] ?? 0) * hours;
  }
  const beamScale = clearBeam.map((clear, month) => {
    const measured = (weather.ghi[month] ?? 0) * (1 - (weather.diffuseShare[month] ?? 1)) * 1000;
    return clear > 0 ? clamp(measured / clear, 0, MAX_BEAM_SCALE) : 0;
  });
  const diffuseScale = clearDiffuse.map((clear, month) => {
    const measured = (weather.ghi[month] ?? 0) * (weather.diffuseShare[month] ?? 1) * 1000;
    return clear > 0 ? clamp(measured / clear, 0, MAX_DIFFUSE_SCALE) : 0;
  });
  const dni = new Float32Array(sky.dni.length);
  const dhi = new Float32Array(sky.dhi.length);
  const ghi = new Float32Array(sky.ghi.length);
  for (let i = 0; i < sky.hours.length; i++) {
    const month = sky.month[i] ?? 0;
    dni[i] = (sky.dni[i] ?? 0) * (beamScale[month] ?? 0);
    dhi[i] = (sky.dhi[i] ?? 0) * (diffuseScale[month] ?? 0);
    ghi[i] = (dni[i] ?? 0) * Math.max(0, sky.toward[i * 3 + 1] ?? 0) + (dhi[i] ?? 0);
  }
  return { ...sky, dni, dhi, ghi };
}

function parseStored(raw: string): MonthlyWeather | null {
  try {
    const value = JSON.parse(raw) as MonthlyWeather;
    return Array.isArray(value.ghi) && value.ghi.length === 12 && Array.isArray(value.diffuseShare) ? value : null;
  } catch {
    return null;
  }
}

function snap(degrees: number): number {
  return Number((Math.round(degrees / CACHE_GRID_DEG) * CACHE_GRID_DEG).toFixed(2));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
