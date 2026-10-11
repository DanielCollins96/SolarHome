import { MercatorCoordinate, type CustomLayerInterface } from 'maplibre-gl';
import {
  AmbientLight,
  Camera,
  DirectionalLight,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { createHouseObject } from '../house/houseMesh.ts';
import type { HouseModel } from '../house/houseModel.ts';

const WALL_RED = 0xd9534f;
const ROOF_RED = 0xb02a2a;

/**
 * Draws the selected buildings' 3D model on the map, so roofs keep their shape. A map extrusion
 * can only raise a footprint into a flat-topped block, which turns a pyramid or a gable into a box.
 */
export function createModelLayer(id: string): {
  layer: CustomLayerInterface;
  setModel: (model: HouseModel | null) => void;
} {
  const scene = new Scene();
  const camera = new Camera();
  const holder = new Group();
  scene.add(holder);
  scene.add(new AmbientLight(0xffffff, 1.4));
  const sun = new DirectionalLight(0xffffff, 1.6);
  // Light from the south-west and above, in the model's frame (x east, y up, z south).
  sun.position.set(-0.5, 1, 0.6);
  scene.add(sun);

  let renderer: WebGLRenderer | null = null;
  let repaint: () => void = () => {};
  let placement = new Matrix4();
  let visible = false;

  const layer: CustomLayerInterface = {
    id,
    type: 'custom',
    // Shares the map's depth buffer, so basemap buildings in front still hide the model.
    renderingMode: '3d',
    onAdd(map, gl) {
      renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      repaint = () => map.triggerRepaint();
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
    render(_gl, options) {
      if (renderer === null || !visible) return;
      const projection = new Matrix4().fromArray(options.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]);
      camera.projectionMatrix = projection.multiply(placement);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  return {
    layer,
    setModel(model) {
      clear(holder);
      visible = model !== null;
      if (model !== null) {
        const built = createHouseObject(model).group;
        paintRed(built);
        holder.add(built);
        placement = placementMatrix(model.origin.longitude, model.origin.latitude);
      }
      repaint();
    },
  };
}

/**
 * From the model's metres (x east, y up, z south) to MapLibre's mercator world, where x runs
 * east, y runs south, and z is height, all in mercator units.
 */
function placementMatrix(longitude: number, latitude: number): Matrix4 {
  const origin = MercatorCoordinate.fromLngLat([longitude, latitude], 0);
  const scale = origin.meterInMercatorCoordinateUnits();
  // prettier-ignore
  const axes = new Matrix4().set(
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  );
  return new Matrix4()
    .makeTranslation(origin.x, origin.y, origin.z)
    .scale(new Vector3(scale, scale, scale))
    .multiply(axes);
}

/** Red like the map's selection. Both sides draw, because the axis swap above mirrors the faces. */
function paintRed(root: Group): void {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const old: Material | Material[] = node.material;
    if (Array.isArray(old)) old.forEach((item) => item.dispose());
    else old.dispose();
    node.material = new MeshLambertMaterial({ color: node.name === 'house-roof' ? ROOF_RED : WALL_RED, side: DoubleSide });
  });
}

function clear(holder: Group): void {
  for (const child of [...holder.children]) {
    holder.remove(child);
    child.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      node.geometry.dispose();
      const material: Material | Material[] = node.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    });
  }
}
