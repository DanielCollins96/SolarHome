import { sunDirection } from '../sun/sunPosition.ts';
import { createRayBlocker, type TriangleSoup } from './rays.ts';

/**
 * A year of sunlight, sampled. One day in the middle of each month stands for the whole month,
 * every 15 minutes while the sun is up. Cloudless from `skySamples`; `applyWeather` dims it to a
 * place's measured months.
 */
export interface SkySamples {
  /** Unit vectors toward the sun, scene frame (X east, Y up, Z south), three floats each. */
  toward: Float32Array;
  /** Direct sunlight on a surface facing the sun, W/m². */
  dni: Float32Array;
  /** Sunlight above the atmosphere, facing the sun, W/m². The share of it that gets through says how clear the sky is. */
  extra: Float32Array;
  /** Sky light on level ground, W/m², sun excluded. */
  dhi: Float32Array;
  /** All light on level ground, W/m². */
  ghi: Float32Array;
  /** Hours of the year this sample stands for. */
  hours: Float32Array;
  /** 1 when broadleaf trees are bare at this sample. */
  leafOff: Uint8Array;
  /** Calendar month of the sample, 0 for January. */
  month: Uint8Array;
}

/** What blocks light, as triangles. Trees let some through. */
export interface Occluders {
  solid: TriangleSoup;
  evergreen: TriangleSoup;
  deciduous: TriangleSoup;
}

export interface ExposureInput {
  /** Measuring points, three floats each, on the roof. */
  points: Float32Array;
  /** Unit normals of the roof at those points, three floats each. */
  normals: Float32Array;
  occluders: Occluders;
  sky: SkySamples;
}

export interface ExposureResult {
  /** Sunlight reaching each point over a year, kWh/m², shade included. */
  kwhPerM2: Float32Array;
  /** The same, with nothing around to cast shade. */
  openKwhPerM2: Float32Array;
}

const STEP_MINUTES = 15;
/** The share of sunlight bounced off the ground: grass and pavement. */
export const GROUND_ALBEDO = 0.2;
/** Light that gets through a crown. Spruce is dense; a bare maple lets most of the sun through. */
export const EVERGREEN_PASS = 0.1;
export const LEAFY_PASS = 0.2;
export const BARE_PASS = 0.6;
/** Lift the measuring point off the roof so its own surface does not shade it. */
const LIFT_M = 0.05;
/** Rays per side for the sky dome, cosine-weighted around the roof's normal. */
const DOME_SIDE = 8;

/** Clear-sky sunlight for a year at a place. Times are UTC, so the time zone does not matter. */
export function skySamples(latitude: number, longitude: number, year: number): SkySamples {
  const toward: number[] = [];
  const dni: number[] = [];
  const extra: number[] = [];
  const dhi: number[] = [];
  const ghi: number[] = [];
  const hours: number[] = [];
  const leafOff: number[] = [];
  const months: number[] = [];
  const steps = (24 * 60) / STEP_MINUTES;
  for (let month = 0; month < 12; month++) {
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const dayOfYear = Math.round((Date.UTC(year, month, 15) - Date.UTC(year, 0, 0)) / 86_400_000);
    const bare = latitude >= 0 ? month >= 10 || month <= 3 : month >= 4 && month <= 9;
    for (let step = 0; step < steps; step++) {
      const instant = new Date(Date.UTC(year, month, 15, 0, step * STEP_MINUTES + STEP_MINUTES / 2));
      const sun = sunDirection(instant, latitude, longitude);
      const light = clearSky(sun.altitudeDeg, dayOfYear);
      if (light === null) continue;
      toward.push(sun.x, sun.y, sun.z);
      dni.push(light.dni);
      extra.push(aboveAtmosphere(dayOfYear));
      dhi.push(light.dhi);
      ghi.push(light.ghi);
      hours.push((days * STEP_MINUTES) / 60);
      leafOff.push(bare ? 1 : 0);
      months.push(month);
    }
  }
  return {
    toward: Float32Array.from(toward),
    dni: Float32Array.from(dni),
    extra: Float32Array.from(extra),
    dhi: Float32Array.from(dhi),
    ghi: Float32Array.from(ghi),
    hours: Float32Array.from(hours),
    leafOff: Uint8Array.from(leafOff),
    month: Uint8Array.from(months),
  };
}

/**
 * Cloudless-sky light from the sun's altitude. Direct beam from Meinel's air-mass formula with
 * Kasten and Young's air mass; total on level ground from Haurwitz; the sky gets the difference.
 * Null below the horizon.
 */
export function clearSky(altitudeDeg: number, dayOfYear: number): { dni: number; dhi: number; ghi: number } | null {
  if (altitudeDeg <= 0) return null;
  const zenithDeg = 90 - altitudeDeg;
  const cosZenith = Math.sin((altitudeDeg * Math.PI) / 180);
  const airMass = 1 / (cosZenith + 0.50572 * Math.pow(96.07995 - zenithDeg, -1.6364));
  const dni = aboveAtmosphere(dayOfYear) * Math.pow(0.7, Math.pow(airMass, 0.678));
  const haurwitz = 1098 * cosZenith * Math.exp(-0.059 / cosZenith);
  const beam = dni * cosZenith;
  const dhi = Math.max(0, haurwitz - beam);
  return { dni, dhi, ghi: beam + dhi };
}

/** Sunlight above the atmosphere, W/m², a little stronger in January when the Earth is nearest the sun. */
function aboveAtmosphere(dayOfYear: number): number {
  return 1361 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
}

/**
 * Sky light split the Hay–Davies way. The clearer the sky, the more of it comes from a bright
 * ring around the sun, which falls on a surface like the direct beam does; the rest comes evenly
 * from the whole sky. An even sky alone undercounts steep sunward roofs by about 5%.
 */
export function skySplit(sky: SkySamples, i: number, incidence: number): { aroundSun: number; even: number } {
  const dhi = sky.dhi[i] ?? 0;
  const clearness = Math.min(1, Math.max(0, (sky.dni[i] ?? 0) / (sky.extra[i] || 1361)));
  // The ring's light on the surface against on level ground. Near the horizon this is capped, as pvlib does.
  const ratio = Math.max(0, incidence) / Math.max(sky.toward[i * 3 + 1] ?? 0, 0.0175);
  return { aroundSun: dhi * clearness * ratio, even: dhi * (1 - clearness) };
}

/** A year of light on an open plane facing this way, kWh/m². Nothing shades it. */
export function openPlaneYield(normal: { x: number; y: number; z: number }, sky: SkySamples): number {
  const skyShare = (1 + normal.y) / 2;
  let total = 0;
  for (let i = 0; i < sky.hours.length; i++) {
    const incidence = normal.x * (sky.toward[i * 3] ?? 0) + normal.y * (sky.toward[i * 3 + 1] ?? 0) + normal.z * (sky.toward[i * 3 + 2] ?? 0);
    const { aroundSun, even } = skySplit(sky, i, incidence);
    const watts = (sky.dni[i] ?? 0) * Math.max(0, incidence) + aroundSun + even * skyShare + GROUND_ALBEDO * (sky.ghi[i] ?? 0) * (1 - skyShare);
    total += watts * (sky.hours[i] ?? 0);
  }
  return total / 1000;
}

/**
 * A plane tilted to the latitude and facing the equator: about the best a fixed panel does here,
 * and the 100% of the heatmap.
 */
export function idealNormal(latitude: number): { x: number; y: number; z: number } {
  const tilt = (Math.min(Math.abs(latitude), 60) * Math.PI) / 180;
  // North of the equator a panel faces south (+Z).
  const south = latitude >= 0 ? 1 : -1;
  return { x: 0, y: Math.cos(tilt), z: south * Math.sin(tilt) };
}

/**
 * Sunlight on each roof point over the year, with the house, its neighbours and the trees in
 * the way. The direct beam is traced to the sun at every sample; the sky is traced once per
 * point along a fixed set of directions, and a tree passes part of what it blocks.
 */
export function computeExposure(input: ExposureInput, onProgress?: (done: number, total: number) => void): ExposureResult {
  const solid = createRayBlocker(input.occluders.solid);
  const evergreen = createRayBlocker(input.occluders.evergreen);
  const deciduous = createRayBlocker(input.occluders.deciduous);
  const { sky } = input;
  const count = Math.floor(input.points.length / 3);
  const kwhPerM2 = new Float32Array(count);
  const openKwhPerM2 = new Float32Array(count);
  const dome = domeDirections();

  /** Share of light that gets through along a ray, for leafy and bare broadleaf trees. */
  const pass = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): [number, number] => {
    if (solid.blocked(ox, oy, oz, dx, dy, dz)) return [0, 0];
    const green = evergreen.blocked(ox, oy, oz, dx, dy, dz) ? EVERGREEN_PASS : 1;
    if (!deciduous.blocked(ox, oy, oz, dx, dy, dz)) return [green, green];
    return [Math.min(green, LEAFY_PASS), Math.min(green, BARE_PASS)];
  };

  for (let cell = 0; cell < count; cell++) {
    const nx = input.normals[cell * 3] ?? 0;
    const ny = input.normals[cell * 3 + 1] ?? 1;
    const nz = input.normals[cell * 3 + 2] ?? 0;
    const ox = (input.points[cell * 3] ?? 0) + nx * LIFT_M;
    const oy = (input.points[cell * 3 + 1] ?? 0) + ny * LIFT_M;
    const oz = (input.points[cell * 3 + 2] ?? 0) + nz * LIFT_M;

    // Sky and ground seen from this point, each as a share of a cosine-weighted hemisphere.
    const frame = basis(nx, ny, nz);
    let skyLeafy = 0;
    let skyBare = 0;
    let ground = 0;
    for (let i = 0; i < dome.length; i += 3) {
      const a = dome[i] ?? 0;
      const b = dome[i + 1] ?? 0;
      const c = dome[i + 2] ?? 1;
      const dx = frame.ux * a + frame.vx * b + nx * c;
      const dy = frame.uy * a + frame.vy * b + ny * c;
      const dz = frame.uz * a + frame.vz * b + nz * c;
      if (dy <= 0) {
        ground++;
        continue;
      }
      const [leafy, bare] = pass(ox, oy, oz, dx, dy, dz);
      skyLeafy += leafy;
      skyBare += bare;
    }
    const rays = dome.length / 3;
    skyLeafy /= rays;
    skyBare /= rays;
    ground /= rays;
    const openSky = (1 + ny) / 2;

    let shaded = 0;
    let open = 0;
    for (let i = 0; i < sky.hours.length; i++) {
      const sx = sky.toward[i * 3] ?? 0;
      const sy = sky.toward[i * 3 + 1] ?? 0;
      const sz = sky.toward[i * 3 + 2] ?? 0;
      const incidence = nx * sx + ny * sy + nz * sz;
      const bare = sky.leafOff[i] === 1;
      const hours = sky.hours[i] ?? 0;
      const dni = sky.dni[i] ?? 0;
      const { aroundSun, even } = skySplit(sky, i, incidence);
      const reflected = GROUND_ALBEDO * (sky.ghi[i] ?? 0);
      let beam = 0;
      if (incidence > 0) {
        beam = dni * incidence;
        // The bright ring round the sun is blocked along with the sun itself.
        const [leafy, leafless] = pass(ox, oy, oz, sx, sy, sz);
        shaded += (beam + aroundSun) * (bare ? leafless : leafy) * hours;
      }
      shaded += (even * (bare ? skyBare : skyLeafy) + reflected * ground) * hours;
      open += (beam + aroundSun + even * openSky + reflected * (1 - openSky)) * hours;
    }
    kwhPerM2[cell] = shaded / 1000;
    openKwhPerM2[cell] = open / 1000;
    if (onProgress !== undefined && (cell % 64 === 63 || cell === count - 1)) onProgress(cell + 1, count);
  }
  return { kwhPerM2, openKwhPerM2 };
}

/** Cosine-weighted directions around +Z in a fixed, evenly spread pattern: x, y, z each. */
function domeDirections(): Float32Array {
  const out = new Float32Array(DOME_SIDE * DOME_SIDE * 3);
  let at = 0;
  for (let ring = 0; ring < DOME_SIDE; ring++) {
    const radius = Math.sqrt((ring + 0.5) / DOME_SIDE);
    for (let spoke = 0; spoke < DOME_SIDE; spoke++) {
      // Each ring turns half a spoke from the last, so the rays do not line up in columns.
      const angle = (2 * Math.PI * (spoke + 0.5 * (ring % 2))) / DOME_SIDE;
      out[at++] = radius * Math.cos(angle);
      out[at++] = radius * Math.sin(angle);
      out[at++] = Math.sqrt(Math.max(0, 1 - radius * radius));
    }
  }
  return out;
}

/** Two unit vectors at right angles to the normal and to each other. */
function basis(nx: number, ny: number, nz: number): { ux: number; uy: number; uz: number; vx: number; vy: number; vz: number } {
  // Cross with whichever axis is least parallel to the normal.
  const [ax, ay, az] = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = ay * nz - az * ny;
  let uy = az * nx - ax * nz;
  let uz = ax * ny - ay * nx;
  const length = Math.hypot(ux, uy, uz) || 1;
  ux /= length;
  uy /= length;
  uz /= length;
  return { ux, uy, uz, vx: ny * uz - nz * uy, vy: nz * ux - nx * uz, vz: nx * uy - ny * ux };
}
