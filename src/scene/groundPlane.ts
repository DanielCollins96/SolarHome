import { GridHelper, Mesh, MeshLambertMaterial, PlaneGeometry } from 'three';

const GROUND_COLOR = 0x9aab86;

/** Ground at y = 0, sized around the demonstration house and its nearby boxes. */
export function createGround(size = 48): Mesh {
  const mesh = new Mesh(
    new PlaneGeometry(size, size),
    new MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  return mesh;
}

/** 2 m grid just above the ground so the lines do not hide shadows. */
export function createGroundGrid(size = 48, step = 2): GridHelper {
  const grid = new GridHelper(size, size / step, 0x667562, 0x7d8b72);
  grid.position.y = 0.015;
  grid.name = 'ground-grid';
  return grid;
}
