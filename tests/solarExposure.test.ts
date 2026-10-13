import { describe, expect, it } from 'vitest';
import { demoHouseModel } from '../src/house/demoHouse.ts';
import type { HouseModel } from '../src/house/houseModel.ts';
import { clearSky, computeExposure, idealNormal, openPlaneYield, skySamples } from '../src/solar/exposure.ts';
import { cellAtUv, cellCorners, cellSamples, collectOccluders, heatColor, roofTotal, summarizeHeat } from '../src/solar/heatmap.ts';
import { createRayBlocker } from '../src/solar/rays.ts';
import { roofGrid } from '../src/solar/roofCells.ts';

const GOLDEN = { latitude: 39.742476, longitude: -105.1786 };
const sky = skySamples(GOLDEN.latitude, GOLDEN.longitude, 2026);

function flatRoof(sizeM: number, eaveM = 3): HouseModel {
  const half = sizeM / 2;
  return {
    ...demoHouseModel(),
    parts: [
      {
        id: 'flat',
        footprint: [
          { east: -half, north: -half },
          { east: half, north: -half },
          { east: half, north: half },
          { east: -half, north: half },
        ],
        holes: [],
        eaveHeightM: eaveM,
        roof: { type: 'flat', directionDeg: 0, pitchDeg: 0, overhangM: 0 },
      },
    ],
  };
}

describe('ray blocker', () => {
  it('agrees with testing every triangle', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const soup = new Float32Array(300 * 9);
    for (let i = 0; i < 300; i++) {
      const cx = random() * 40 - 20, cy = random() * 20, cz = random() * 40 - 20;
      for (let corner = 0; corner < 3; corner++) {
        soup.set([cx + random() * 3, cy + random() * 3, cz + random() * 3], i * 9 + corner * 3);
      }
    }
    const tree = createRayBlocker(soup);
    for (let ray = 0; ray < 400; ray++) {
      const origin = [random() * 50 - 25, random() * 5, random() * 50 - 25] as const;
      const raw = [random() - 0.5, random(), random() - 0.5];
      const length = Math.hypot(...raw);
      const d = raw.map((value) => value / length) as [number, number, number];
      let brute = false;
      for (let i = 0; i < 300 && !brute; i++) brute = createRayBlocker(soup.subarray(i * 9, i * 9 + 9)).blocked(...origin, ...d);
      expect(tree.blocked(...origin, ...d)).toBe(brute);
      // The nearest hit is a hit exactly when the ray is blocked.
      expect(tree.nearest(...origin, ...d) >= 0).toBe(brute);
    }
  });
});

describe('clear sky', () => {
  it('gives about 1000 W/m² with the sun overhead and nothing below the horizon', () => {
    const noon = clearSky(90, 172);
    expect(noon?.ghi).toBeGreaterThan(950);
    expect(noon?.ghi).toBeLessThan(1100);
    expect(clearSky(-1, 172)).toBeNull();
  });

  it('puts the ideal panel at Golden near published clear-sky totals', () => {
    // A real year at Golden is about 2,000 kWh/m² on a latitude tilt; clear skies give more.
    const ideal = openPlaneYield(idealNormal(GOLDEN.latitude), sky);
    expect(ideal).toBeGreaterThan(2200);
    expect(ideal).toBeLessThan(3100);
  });
});

describe('sky light', () => {
  it('leaves level ground with exactly the light it gets, and gives a sunward slope the bright ring round the sun', () => {
    let level = 0;
    for (let i = 0; i < sky.hours.length; i++) level += ((sky.ghi[i] ?? 0) * (sky.hours[i] ?? 0)) / 1000;
    expect(openPlaneYield({ x: 0, y: 1, z: 0 }, sky)).toBeCloseTo(level, 3);
    // Facing the noon sun, the ring adds to what an even sky would give.
    const south = idealNormal(GOLDEN.latitude);
    let even = 0;
    for (let i = 0; i < sky.hours.length; i++) {
      const incidence = south.x * (sky.toward[i * 3] ?? 0) + south.y * (sky.toward[i * 3 + 1] ?? 0) + south.z * (sky.toward[i * 3 + 2] ?? 0);
      even += (((sky.dni[i] ?? 0) * Math.max(0, incidence) + (sky.dhi[i] ?? 0) * ((1 + south.y) / 2) + 0.2 * (sky.ghi[i] ?? 0) * ((1 - south.y) / 2)) * (sky.hours[i] ?? 0)) / 1000;
    }
    expect(openPlaneYield(south, sky)).toBeGreaterThan(even);
  });
});

describe('roof grid', () => {
  it('covers the demonstration gable in 1 m squares along the slope', () => {
    const grid = roofGrid(demoHouseModel());
    expect(grid.faces).toHaveLength(2);
    const area = grid.cells.reduce((sum, cell) => sum + cell.areaM2, 0);
    // 12 m by 8 m in plan, sloped at 30°.
    expect(area).toBeCloseTo((12 * 8) / Math.cos(Math.PI / 6), 0);
    const south = grid.faces.find((face) => Math.abs(face.azimuthDeg - 180) < 1);
    expect(south?.tiltDeg).toBeCloseTo(30, 3);
    expect(south?.cols).toBe(12);
    expect(south?.rows).toBe(5);
  });
});

describe('buried roof', () => {
  it('drops porch roof that runs on inside the main part, and keeps the rest', () => {
    const main = flatRoof(10, 6).parts[0];
    if (main === undefined) throw new Error('missing part');
    // A 3 m porch along the south wall that reaches 2 m inside the main walls.
    const porch = {
      ...main,
      id: 'porch',
      footprint: [{ east: -3, north: -8 }, { east: 3, north: -8 }, { east: 3, north: -3 }, { east: -3, north: -3 }],
      eaveHeightM: 3,
    };
    const grid = roofGrid({ ...flatRoof(10, 6), parts: [main, porch] });
    const porchCells = grid.cells.filter((cell) => cell.point.y < 4);
    // The porch is 6 m by 5 m; the 6 m by 2 m strip inside the main part is gone.
    expect(porchCells.reduce((sum, cell) => sum + cell.areaM2, 0)).toBeCloseTo(18, 0);
    expect(porchCells.every((cell) => -cell.point.z < -5)).toBe(true);
    // The main roof is untouched.
    expect(grid.cells.filter((cell) => cell.point.y > 4).reduce((sum, cell) => sum + cell.areaM2, 0)).toBeCloseTo(100, 0);
  });
});

describe('picking a square', () => {
  it('finds each square from a point inside it, and outlines it around its centre', () => {
    const grid = roofGrid(demoHouseModel());
    grid.cells.forEach((cell, i) => {
      const face = grid.faces[cell.face];
      if (face === undefined) throw new Error('missing face');
      expect(cellAtUv(grid, cell.face, { x: (cell.col + 0.5) / face.cols, y: (cell.row + 0.5) / face.rows })).toBe(i);
      const corners = cellCorners(grid, i);
      const middle = [0, 1, 2].map((axis) => ((corners[axis] ?? 0) + (corners[axis + 6] ?? 0)) / 2);
      if (cell.areaM2 === 1) {
        expect(Math.hypot((middle[0] ?? 0) - cell.point.x, (middle[1] ?? 0) - cell.point.y, (middle[2] ?? 0) - cell.point.z)).toBeLessThan(0.1);
      }
    });
  });
});

describe('roof exposure', () => {
  const run = (model: HouseModel, neighbours: Parameters<typeof collectOccluders>[2] = []) => {
    const grid = roofGrid(model);
    const { points, normals } = cellSamples(grid);
    const result = computeExposure({ points, normals, occluders: collectOccluders(model, [], neighbours), sky });
    return { grid, result };
  };

  it('gives the south slope more sun than the north slope', () => {
    const { grid, result } = run(demoHouseModel());
    const mean = (azimuth: number) => {
      const values = grid.cells.flatMap((cell, i) => (Math.abs((grid.faces[cell.face]?.azimuthDeg ?? 0) - azimuth) < 1 ? [result.kwhPerM2[i] ?? 0] : []));
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    expect(mean(180)).toBeGreaterThan(mean(0) * 1.4);
  });

  it('adds up each roof side and the whole roof of a building', () => {
    const { grid, result } = run(demoHouseModel());
    const ideal = openPlaneYield(idealNormal(GOLDEN.latitude), sky);
    const sides = grid.faces.map((_, face) => roofTotal(grid, result.kwhPerM2, ideal, { face }));
    const whole = roofTotal(grid, result.kwhPerM2, ideal, { building: grid.faces[0]?.building ?? '' });
    expect(whole.areaM2).toBeCloseTo((sides[0]?.areaM2 ?? 0) + (sides[1]?.areaM2 ?? 0), 6);
    expect(whole.kwh).toBeCloseTo((sides[0]?.kwh ?? 0) + (sides[1]?.kwh ?? 0), 0);
    const south = sides[grid.faces.findIndex((face) => Math.abs(face.azimuthDeg - 180) < 1)];
    expect(south?.meanShare).toBeGreaterThan(whole.meanShare);
    expect(whole.goodM2).toBeLessThanOrEqual(whole.areaM2);
  });

  it('leaves an open flat roof unshaded', () => {
    const { result } = run(flatRoof(6));
    result.kwhPerM2.forEach((kwh, i) => expect(kwh / (result.openKwhPerM2[i] ?? 1)).toBeGreaterThan(0.99));
  });

  it('shades the part of a flat roof just north of a tall block', () => {
    // A 12 m block just south of a 10 m roof: the south edge is in its shadow most of the winter.
    const block = { ring: [{ east: -6, north: -9 }, { east: 6, north: -9 }, { east: 6, north: -6 }, { east: -6, north: -6 }], heightM: 12, baseM: 0 };
    const { grid, result } = run(flatRoof(10), [block]);
    const row = (north: number) => {
      const values = grid.cells.flatMap((cell, i) => (Math.abs(-cell.point.z - north) < 0.6 && Math.abs(cell.point.x) < 2 ? [result.kwhPerM2[i] ?? 0] : []));
      return values.reduce((a, b) => a + b, 0) / values.length;
    };
    expect(row(-4.5)).toBeLessThan(row(4.5) * 0.85);
    const summary = summarizeHeat(grid, result, openPlaneYield(idealNormal(GOLDEN.latitude), sky));
    expect(summary.shadeLoss).toBeGreaterThan(0.03);
    expect(summary.roofM2).toBeCloseTo(100, 3);
  });
});

describe('heat colours', () => {
  it('runs from dark at none to pale at full', () => {
    const [r0, g0, b0] = heatColor(0);
    const [r1, g1, b1] = heatColor(1);
    expect(r0 + g0 + b0).toBeLessThan(r1 + g1 + b1);
    expect(heatColor(2)).toEqual(heatColor(1));
  });
});
