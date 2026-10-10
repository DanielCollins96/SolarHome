import { BoxGeometry, Group, Mesh, MeshLambertMaterial } from 'three';

export interface NeighbourBox {
  name: string;
  /** East-west size, meters. */
  width: number;
  /** North-south size, meters. */
  depth: number;
  height: number;
  /** Footprint center, east of the house centroid. */
  east: number;
  /** Footprint center, south of the house centroid (scene +Z). */
  south: number;
  color: number;
}

/**
 * A few boxes around the centered house. They do not move the scene origin.
 * Positions are in scene meters: X east, Z south.
 */
export const DEMO_NEIGHBOURS: readonly NeighbourBox[] = [
  { name: 'east-box', width: 5, depth: 6, height: 8, east: 11, south: 1, color: 0x8e9aab },
  { name: 'north-box', width: 7, depth: 5, height: 11, east: -2, south: -10, color: 0x7d8b9a },
  { name: 'south-box', width: 4, depth: 4, height: 4, east: -11, south: 9, color: 0x6e7c8a },
];

export function createNeighbourGroup(boxes: readonly NeighbourBox[] = DEMO_NEIGHBOURS): Group {
  const group = new Group();
  group.name = 'neighbours';
  for (const box of boxes) {
    const mesh = new Mesh(
      new BoxGeometry(box.width, box.height, box.depth),
      new MeshLambertMaterial({ color: box.color }),
    );
    mesh.name = box.name;
    mesh.position.set(box.east, box.height / 2, box.south);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
