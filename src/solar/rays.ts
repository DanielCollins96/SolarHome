/**
 * Triangles in scene metres, nine floats each: ax ay az bx by bz cx cy cz.
 * Plain arrays so they cross into a worker without three.js.
 */
export type TriangleSoup = Float32Array;

/** Leaves hold at most this many triangles. Small leaves cost more nodes but fewer triangle tests. */
const LEAF_SIZE = 4;
const EPSILON = 1e-7;

/**
 * A bounding-volume hierarchy for "does anything block this ray?" questions. Built once per
 * scene, then asked hundreds of thousands of times, so the nodes live in flat typed arrays.
 */
export interface RayBlocker {
  /** True when a ray from the origin along the unit direction meets any triangle. */
  blocked(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean;
  /** The first triangle a ray meets, as its index in the soup, or -1 when it meets none. */
  nearest(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number;
  readonly triangleCount: number;
}

export function createRayBlocker(triangles: TriangleSoup): RayBlocker {
  const count = Math.floor(triangles.length / 9);
  if (count === 0) return { blocked: () => false, nearest: () => -1, triangleCount: 0 };

  const order = new Uint32Array(count);
  const centers = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    const base = i * 9;
    for (let axis = 0; axis < 3; axis++) {
      centers[i * 3 + axis] = ((triangles[base + axis] ?? 0) + (triangles[base + 3 + axis] ?? 0) + (triangles[base + 6 + axis] ?? 0)) / 3;
    }
  }

  // At most 2n nodes. Each holds a box, then either two children or a run of `order`.
  const capacity = Math.max(1, 2 * count);
  const boxes = new Float32Array(capacity * 6);
  /** Leaf: first index into `order`. Inner: the left child; the right child is `left + 1`. */
  const firsts = new Uint32Array(capacity);
  /** Leaf: how many triangles. Inner: 0. */
  const counts = new Uint32Array(capacity);
  let used = 1;

  const fitBox = (node: number, start: number, end: number) => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const base = (order[i] ?? 0) * 9;
      for (let corner = 0; corner < 9; corner += 3) {
        const x = triangles[base + corner] ?? 0;
        const y = triangles[base + corner + 1] ?? 0;
        const z = triangles[base + corner + 2] ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }
    boxes.set([minX, minY, minZ, maxX, maxY, maxZ], node * 6);
  };

  // Split at the middle of the longest side of the centres' box, so nearby triangles share a leaf.
  const stack: [number, number, number][] = [[0, 0, count]];
  while (stack.length > 0) {
    const [node, start, end] = stack.pop() as [number, number, number];
    fitBox(node, start, end);
    if (end - start <= LEAF_SIZE) {
      firsts[node] = start;
      counts[node] = end - start;
      continue;
    }
    const low = [Infinity, Infinity, Infinity];
    const high = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < end; i++) {
      const at = (order[i] ?? 0) * 3;
      for (let axis = 0; axis < 3; axis++) {
        const value = centers[at + axis] ?? 0;
        if (value < (low[axis] ?? 0)) low[axis] = value;
        if (value > (high[axis] ?? 0)) high[axis] = value;
      }
    }
    let axis = 0;
    for (let next = 1; next < 3; next++) {
      if ((high[next] ?? 0) - (low[next] ?? 0) > (high[axis] ?? 0) - (low[axis] ?? 0)) axis = next;
    }
    const middle = ((low[axis] ?? 0) + (high[axis] ?? 0)) / 2;
    let split = start;
    for (let i = start; i < end; i++) {
      const triangle = order[i] ?? 0;
      if ((centers[triangle * 3 + axis] ?? 0) < middle) {
        order[i] = order[split] ?? 0;
        order[split] = triangle;
        split++;
      }
    }
    // Every centre on one side, such as a stack of identical triangles: halve the run instead.
    if (split === start || split === end) split = (start + end) >> 1;
    const left = used;
    used += 2;
    firsts[node] = left;
    counts[node] = 0;
    stack.push([left, start, split], [left + 1, split, end]);
  }

  // Depth-first, so the stack holds at most one sibling per level of the tree.
  const visit = new Uint32Array(Math.max(64, 2 * treeDepth(firsts, counts)));

  /** Walk the tree for one ray. `firstOnly` stops at any hit; otherwise it keeps the closest. */
  const trace = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, firstOnly: boolean): number => {
    let best = -1;
    let bestT = Infinity;
    const invX = 1 / dx;
    const invY = 1 / dy;
    const invZ = 1 / dz;
    let top = 0;
    visit[top++] = 0;
    while (top > 0) {
      const node = visit[--top] ?? 0;
      const b = node * 6;
      // Slab test against the node's box.
      let t1 = ((boxes[b] ?? 0) - ox) * invX;
      let t2 = ((boxes[b + 3] ?? 0) - ox) * invX;
      let near = Math.min(t1, t2);
      let far = Math.max(t1, t2);
      t1 = ((boxes[b + 1] ?? 0) - oy) * invY;
      t2 = ((boxes[b + 4] ?? 0) - oy) * invY;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
      t1 = ((boxes[b + 2] ?? 0) - oz) * invZ;
      t2 = ((boxes[b + 5] ?? 0) - oz) * invZ;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
      // NaN, from a zero direction component on the box's own face, fails both tests and is kept.
      if (far < 0 || near > far || near > bestT) continue;
      const run = counts[node] ?? 0;
      if (run === 0) {
        const left = firsts[node] ?? 0;
        visit[top++] = left;
        visit[top++] = left + 1;
        continue;
      }
      const first = firsts[node] ?? 0;
      for (let i = first; i < first + run; i++) {
        const triangle = order[i] ?? 0;
        const t = hitDistance(triangles, triangle * 9, ox, oy, oz, dx, dy, dz);
        if (t < 0 || t >= bestT) continue;
        if (firstOnly) return triangle;
        best = triangle;
        bestT = t;
      }
    }
    return best;
  };

  return {
    triangleCount: count,
    blocked: (ox, oy, oz, dx, dy, dz) => trace(ox, oy, oz, dx, dy, dz, true) >= 0,
    nearest: (ox, oy, oz, dx, dy, dz) => trace(ox, oy, oz, dx, dy, dz, false),
  };
}

function treeDepth(firsts: Uint32Array, counts: Uint32Array): number {
  let deepest = 0;
  const stack: [number, number][] = [[0, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [number, number];
    deepest = Math.max(deepest, depth);
    if ((counts[node] ?? 0) > 0) continue;
    const left = firsts[node] ?? 0;
    stack.push([left, depth + 1], [left + 1, depth + 1]);
  }
  return deepest + 1;
}

/** Möller–Trumbore, either side of the triangle. The distance along the ray, or -1 for a miss or a hit behind the origin. */
function hitDistance(t: TriangleSoup, base: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const ax = t[base] ?? 0, ay = t[base + 1] ?? 0, az = t[base + 2] ?? 0;
  const e1x = (t[base + 3] ?? 0) - ax, e1y = (t[base + 4] ?? 0) - ay, e1z = (t[base + 5] ?? 0) - az;
  const e2x = (t[base + 6] ?? 0) - ax, e2y = (t[base + 7] ?? 0) - ay, e2z = (t[base + 8] ?? 0) - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -EPSILON && det < EPSILON) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return distance > EPSILON ? distance : -1;
}
