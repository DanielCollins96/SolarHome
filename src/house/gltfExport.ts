import type { Object3D } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

/** Binary glTF of the current house. Textures are not required for these solid colours. */
export async function exportHouseGlb(root: Object3D): Promise<Blob> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, { binary: true });
  if (!(result instanceof ArrayBuffer)) throw new Error('glTF export did not return a binary file.');
  return new Blob([result], { type: 'model/gltf-binary' });
}
