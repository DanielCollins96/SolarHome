import { ExtrudeGeometry, Group, Mesh, MeshLambertMaterial, Shape, Vector2 } from 'three';
import type { PlanPoint } from '../house/centering.ts';

/** About the basemap's light gray, so a redrawn neighbour looks like the buildings around it. */
const BLOCK_GRAY = 0xf4f1ec;
const ROOF_LIFT_M = 0.2;

/**
 * Flat-topped blocks for neighbouring buildings, in scene metres: the map's own outline raised
 * from its base to its height. They exist to take and cast shadows, so they all do both.
 */
export function createBlockGroup(blocks: readonly { ring: readonly PlanPoint[]; heightM: number; baseM: number }[]): Group {
  const group = new Group();
  group.name = 'neighbour-blocks';
  const material = new MeshLambertMaterial({ color: BLOCK_GRAY });
  for (const block of blocks) {
    if (block.ring.length < 3 || block.heightM <= block.baseM) continue;
    const shape = new Shape(block.ring.map((point) => new Vector2(point.east, point.north)));
    // A hair taller than the map's own block, so a roof the map has not flattened yet never shares a plane with it.
    const geometry = new ExtrudeGeometry(shape, { depth: block.heightM - block.baseM + ROOF_LIFT_M, bevelEnabled: false });
    // The outline lies in x/y with depth along z. Turn it so depth runs up and plan north is -z.
    geometry.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geometry, material);
    mesh.position.y = block.baseM;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
