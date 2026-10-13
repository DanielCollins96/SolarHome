import {
  BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RingGeometry,
} from 'three';
import type { PlanPoint } from '../house/centering.ts';
import { pointInRing } from '../house/planGeometry.ts';

export type TreeKind = 'evergreen' | 'deciduous';

/** A tree crown seen from above, in scene metres around the model's origin. */
export interface TreeCrown {
  outline: PlanPoint[];
  /** From the city's tree inventory when a listed tree stands in this crown; guessed from shape otherwise. */
  kind?: TreeKind;
}

/** A listed tree with no canopy outline around it, usually one too young to reach 2 m. */
export interface TreePoint {
  at: PlanPoint;
  kind: TreeKind;
  /** Crown width, metres. */
  widthM: number;
}

/** Smaller patches are shrubs or edge noise in the canopy outlines. */
const SMALLEST_CROWN_M2 = 2;
/** A crown wider than this is a clump of trees whose crowns touch. */
const CLUMP_AREA_M2 = 110;
/** A round patch this small is most often a spruce or pine in Calgary yards. */
const EVERGREEN_AREA_M2 = 45;
/** A clump thinner than this, on average, is a row of evergreens along a fence. */
const ROW_THICKNESS_M = 5.5;

/** Spruce and pine: two to three times as tall as they are wide. */
export function evergreenHeight(widthM: number): number {
  return clamp(2.6 * widthM, 3, 24);
}

/** Mountain ash, maple, elm: a little taller than wide, rarely past 16 m in Calgary. */
export function deciduousHeight(widthM: number): number {
  return clamp(1.3 * widthM + 1, 3, 16);
}

/** One tree to draw, in scene metres around the model's origin. */
export interface TreeSpec {
  id: string;
  at: PlanPoint;
  kind: TreeKind;
  /** Crown width, metres. */
  widthM: number;
  /** Set by the person. Otherwise the height follows from the width and the kind. */
  heightM?: number;
}

/** The height a tree is drawn at: the person's own, or the usual one for its width and kind. */
export function treeHeightOf(tree: { kind: TreeKind; widthM: number; heightM?: number }): number {
  if (tree.heightM !== undefined) return tree.heightM;
  return tree.kind === 'evergreen' ? evergreenHeight(tree.widthM) : deciduousHeight(tree.widthM);
}

/**
 * Trees for the canopy outlines and listed trees around a model. None stands on a selected
 * building: the canopy over a roof is a branch reaching over it, not a trunk through it.
 */
export function planTrees(crowns: readonly TreeCrown[], points: readonly TreePoint[] = [], avoid: readonly PlanPoint[][] = []): Omit<TreeSpec, 'id'>[] {
  const trees: Omit<TreeSpec, 'id'>[] = [];
  const clear = (at: PlanPoint) => !avoid.some((ring) => pointInRing(at, ring));
  for (const crown of crowns) {
    const area = Math.abs(ringArea(crown.outline));
    if (area < SMALLEST_CROWN_M2) continue;
    if (area <= CLUMP_AREA_M2) {
      const at = centroid(crown.outline);
      const widthM = 2 * Math.sqrt(area / Math.PI);
      const kind = crown.kind ?? (area <= EVERGREEN_AREA_M2 ? 'evergreen' : 'deciduous');
      if (clear(at)) trees.push({ at, kind, widthM });
      continue;
    }
    // Several trees whose crowns merged in the canopy. A thin clump is a row of evergreens.
    const thickness = (2 * area) / ringPerimeter(crown.outline);
    const kind = crown.kind ?? (thickness < ROW_THICKNESS_M ? 'evergreen' : 'deciduous');
    // Mature spruce stand 6 to 7 m apart and broadleaf trees about 9 m, so a clump holds about
    // as many trees as its area allows at that spacing.
    const spacing = kind === 'evergreen' ? 6.5 : 9;
    for (const at of spotsInside(crown.outline, spacing)) {
      if (clear(at)) trees.push({ at, kind, widthM: spacing });
    }
  }
  for (const point of points) {
    if (clear(point.at)) trees.push({ at: point.at, kind: point.kind, widthM: point.widthM });
  }
  return trees;
}

/** Meshes for the trees. The selected tree stands on a yellow ring. Every piece casts and receives shadows. */
export function createTreeGroup(trees: readonly TreeSpec[], selectedId: string | null = null): Group {
  const kit = treeKit();
  const group = new Group();
  group.name = 'trees';
  for (const spec of trees) {
    const tree = addTree(group, kit, spec.at, spec.kind, spec.widthM, treeHeightOf(spec));
    tree.userData.treeId = spec.id;
    if (spec.id === selectedId) {
      const ring = new Mesh(new RingGeometry(spec.widthM / 2 + 0.3, spec.widthM / 2 + 1, 40), new MeshBasicMaterial({ color: 0xffc107, side: DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(spec.at.east, 0.15, -spec.at.north);
      ring.userData.ringFor = spec.id;
      group.add(ring);
    }
  }
  return group;
}

/** Move one drawn tree, and its ring, while it is dragged. The full redraw waits for the drop. */
export function moveTreeMesh(group: Group, id: string, at: PlanPoint): void {
  group.traverse((node) => {
    if (node.userData.treeId !== id && node.userData.ringFor !== id) return;
    node.position.x = at.east;
    node.position.z = -at.north;
  });
}

interface TreeKit {
  cone: BufferGeometry;
  blob: BufferGeometry;
  trunk: BufferGeometry;
  needles: MeshLambertMaterial[];
  leaves: MeshLambertMaterial[];
  bark: MeshLambertMaterial;
}

/** Shared shapes and a few shades, so a street of trees is not hundreds of separate geometries. */
function treeKit(): TreeKit {
  const shade = (colors: number[]) => colors.map((color) => new MeshLambertMaterial({ color, flatShading: true }));
  return {
    cone: new ConeGeometry(1, 1, 9, 1),
    blob: new IcosahedronGeometry(1, 1),
    trunk: new CylinderGeometry(0.7, 1, 1, 7),
    needles: shade([0x2c4a36, 0x34513a, 0x263f31, 0x3a5940]),
    leaves: shade([0x5a7d38, 0x4f7233, 0x66873f, 0x4a6a2f]),
    bark: new MeshLambertMaterial({ color: 0x5a4430 }),
  };
}

function addTree(group: Group, kit: TreeKit, at: PlanPoint, kind: TreeKind, widthM: number, height: number): Group {
  const random = seeded(at);
  const tree = new Group();
  tree.position.set(at.east, 0, -at.north);
  tree.rotation.y = random() * Math.PI * 2;
  if (kind === 'evergreen') buildEvergreen(tree, kit, widthM, height, random);
  else buildDeciduous(tree, kit, widthM, height, random);
  tree.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  group.add(tree);
  return tree;
}

/**
 * Spruce in a yard: the lowest branches lifted a couple of metres clear of the lawn, the crown
 * widest a little above them, then narrowing to a spire. Overlapping tiers of cones, each a
 * little narrower than the one below, so the outline tapers rather than flaring at the bottom.
 */
function buildEvergreen(tree: Group, kit: TreeKit, widthM: number, height: number, random: () => number): void {
  const radius = widthM / 2;
  // About 2 m of bare trunk on a grown tree, less on a young one.
  const bare = Math.min(2.2, height * 0.13);
  add(tree, kit.trunk, kit.bark, radius * 0.08, bare + height * 0.2, 0);
  const material = pick(kit.needles, random);
  const tiers = 5;
  const crown = height - bare;
  for (let tier = 0; tier < tiers; tier += 1) {
    const share = tier / tiers;
    // The bottom tier is the lifted skirt, a little short of the widest tier above it.
    const profile = tier === 0 ? 0.86 : 1 - (share - 0.2) * 0.85;
    const tierRadius = radius * profile * (0.94 + random() * 0.12);
    // Short, steep cones: a tier's skirt barely spreads past the tier above.
    const base = bare + crown * share * 0.8;
    // The top tier runs up to the tree's full height, so the spire is the height the tree is given.
    const tierHeight = tier === tiers - 1 ? height - base : crown * (0.32 - share * 0.04);
    const cone = new Mesh(kit.cone, material);
    cone.scale.set(tierRadius, tierHeight, tierRadius);
    cone.position.y = base + tierHeight / 2;
    tree.add(cone);
  }
}

/** Broadleaf: a trunk to about 40% of the height, under a crown of a few overlapping lumps. */
function buildDeciduous(tree: Group, kit: TreeKit, widthM: number, height: number, random: () => number): void {
  const radius = widthM / 2;
  const crownBottom = height * 0.38;
  const crownMiddle = (crownBottom + height) / 2;
  const crownHalf = (height - crownBottom) / 2;
  add(tree, kit.trunk, kit.bark, Math.max(0.12, radius * 0.07), crownMiddle, 0);
  const material = pick(kit.leaves, random);
  const lumps = 5 + Math.floor(random() * 3);
  for (let lump = 0; lump < lumps; lump += 1) {
    const angle = (lump / lumps) * Math.PI * 2 + random() * 0.8;
    const out = lump === 0 ? 0 : radius * (0.35 + random() * 0.25);
    const size = lump === 0 ? radius * 0.75 : radius * (0.45 + random() * 0.2);
    const blob = new Mesh(kit.blob, material);
    blob.scale.set(size, size * (crownHalf / radius) * (0.85 + random() * 0.3), size);
    blob.position.set(Math.cos(angle) * out, crownMiddle + (random() - 0.4) * crownHalf * 0.6, Math.sin(angle) * out);
    tree.add(blob);
  }
}

function add(tree: Group, geometry: BufferGeometry, material: MeshLambertMaterial, radius: number, height: number, y: number): void {
  const mesh = new Mesh(geometry, material);
  mesh.scale.set(radius, height, radius);
  mesh.position.y = y + height / 2;
  tree.add(mesh);
}

/** Grid points inside an outline, offset on alternate rows so the crowns do not line up. */
function spotsInside(outline: readonly PlanPoint[], spacing: number): PlanPoint[] {
  const east = outline.map((point) => point.east);
  const north = outline.map((point) => point.north);
  const spots: PlanPoint[] = [];
  let row = 0;
  for (let y = Math.min(...north) + spacing / 2; y < Math.max(...north); y += spacing * 0.87, row += 1) {
    for (let x = Math.min(...east) + (row % 2 === 0 ? spacing / 2 : spacing); x < Math.max(...east); x += spacing) {
      if (pointInRing({ east: x, north: y }, outline)) spots.push({ east: x, north: y });
    }
  }
  return spots.length > 0 ? spots : [centroid(outline)];
}

/** The same tree looks the same every time it is drawn. */
function seeded(at: PlanPoint): () => number {
  let state = (Math.floor(at.east * 97) * 73856093) ^ (Math.floor(at.north * 89) * 19349663);
  return () => {
    state = (state * 1664525 + 1013904223) | 0;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length) % items.length] as T;
}

function ringArea(points: readonly PlanPoint[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    twice += a.east * b.north - b.east * a.north;
  }
  return twice / 2;
}

function ringPerimeter(points: readonly PlanPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (a === undefined || b === undefined) continue;
    total += Math.hypot(b.east - a.east, b.north - a.north);
  }
  return Math.max(total, 1e-6);
}

function centroid(points: readonly PlanPoint[]): PlanPoint {
  const east = points.reduce((sum, point) => sum + point.east, 0) / points.length;
  const north = points.reduce((sum, point) => sum + point.north, 0) / points.length;
  return { east, north };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
