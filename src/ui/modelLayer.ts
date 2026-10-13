import { MercatorCoordinate, type CustomLayerInterface } from 'maplibre-gl';
import {
  AmbientLight,
  Box3,
  Camera,
  DirectionalLight,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PCFShadowMap,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  ShadowMaterial,
  Sphere,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { createHouseObject } from '../house/houseMesh.ts';
import type { PlanPoint } from '../house/centering.ts';
import type { HouseModel } from '../house/houseModel.ts';
import { createBlockGroup } from '../scene/blockMesh.ts';
import { createTreeGroup, moveTreeMesh, type TreeSpec } from '../scene/treeMesh.ts';
import { projectToLocal, type LngLat } from '../geo/projection.ts';
import { disposeHeatOverlay } from '../solar/heatmap.ts';
import type { SunDirection } from '../sun/sunPosition.ts';

const WALL_RED = 0xd9534f;
const ROOF_RED = 0xb02a2a;
const SHADOW_OPACITY = 0.55;
/** Dark blue rather than black, so the shadow stands apart from the basemap's gray buildings. */
const SHADOW_COLOR = 0x1b2a55;
/** Low fill and a strong sun, so a shaded roof or wall reads clearly darker than a sunlit one. */
const FILL_LIGHT = 0.8;
const SUN_LIGHT = 2.6;
/** With the sun down there is no shading to show, so the fill alone keeps the model readable. */
const NIGHT_FILL_LIGHT = 1.8;
/** A sun this close to the horizon throws shadows kilometres long. Clamp so the shadow map keeps some detail. */
const LOWEST_SHADOW_ALTITUDE_DEG = 3;

/**
 * Draws the selected buildings' 3D model on the map, so roofs keep their shape. A map extrusion
 * can only raise a footprint into a flat-topped block, which turns a pyramid or a gable into a box.
 * The model casts its shadow from the same sun as the 3D view onto a clear ground sheet.
 */
export function createModelLayer(id: string): {
  layer: CustomLayerInterface;
  setModel: (model: HouseModel | null) => void;
  setSun: (sun: SunDirection) => void;
  /** Trees around the model, in its metres. They shade it and the ground. */
  setTrees: (trees: readonly TreeSpec[], selectedId: string | null) => void;
  /** Basemap buildings near the model, redrawn here so they take and cast shadows. */
  setNeighbours: (blocks: readonly { ring: readonly LngLat[]; heightM: number; baseM: number }[]) => void;
  /** Move one drawn tree while it is dragged. */
  moveTree: (id: string, at: PlanPoint) => void;
  /** The solar heatmap over the roofs, in the model's metres. Null takes it away. */
  setHeat: (overlay: Group | null) => void;
  /** The tree under a point on the map canvas, and where that point meets the ground, in model metres. */
  pick: (x: number, y: number) => { treeId: string | null; ground: PlanPoint | null };
} {
  const scene = new Scene();
  const camera = new Camera();
  const holder = new Group();
  scene.add(holder);
  const trees = new Group();
  scene.add(trees);
  const neighbours = new Group();
  scene.add(neighbours);
  const heat = new Group();
  scene.add(heat);
  let origin: LngLat | null = null;
  let neighbourBlocks: readonly { ring: readonly LngLat[]; heightM: number; baseM: number }[] = [];
  const fill = new AmbientLight(0xffffff, FILL_LIGHT);
  scene.add(fill);
  const sun = new DirectionalLight(0xffffff, SUN_LIGHT);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  // The shadow now spans the trees and neighbours, so a texel is a few centimetres or more.
  // A larger offset keeps flat roofs from speckling with their own shadow.
  sun.shadow.normalBias = 0.12;
  scene.add(sun);
  scene.add(sun.target);
  // Shows only the shadow that falls on it, so the map stays visible underneath.
  const ground = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ color: SHADOW_COLOR, opacity: SHADOW_OPACITY }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const raycaster = new Raycaster();
  let canvasSize: { width: number; height: number } | null = null;
  let renderer: WebGLRenderer | null = null;
  let repaint: () => void = () => {};
  let placement = new Matrix4();
  let visible = false;
  let bounds = new Sphere();
  let height = 0;
  // Sun from the south-west until the clock sets it.
  let towardSun = new Vector3(-0.5, 1, 0.6).normalize();
  let sunUp = true;

  /** The neighbours in the current model's metres. They move with it when a new model arrives. */
  const drawNeighbours = () => {
    clear(neighbours);
    if (origin === null || neighbourBlocks.length === 0) return;
    const from = origin;
    neighbours.add(createBlockGroup(neighbourBlocks.map((block) => ({ ...block, ring: block.ring.map((point) => projectToLocal(point, from)) }))));
  };

  // The shadow covers the model, its trees and its neighbours together.
  const fitBounds = () => {
    const box = new Box3().setFromObject(holder).union(new Box3().setFromObject(trees)).union(new Box3().setFromObject(neighbours));
    if (!box.isEmpty()) {
      bounds = box.getBoundingSphere(new Sphere());
      height = Math.max(box.max.y, 0);
    }
    placeSun();
  };

  // Fit the light's shadow camera around the model, and the ground sheet around the longest shadow.
  const placeSun = () => {
    sun.intensity = sunUp ? SUN_LIGHT : 0;
    fill.intensity = sunUp ? FILL_LIGHT : NIGHT_FILL_LIGHT;
    ground.visible = sunUp;
    const radius = Math.max(bounds.radius, 1);
    const altitude = Math.max(Math.asin(Math.min(towardSun.y, 1)), (LOWEST_SHADOW_ALTITUDE_DEG * Math.PI) / 180);
    const shadowLength = height / Math.tan(altitude);
    const distance = radius * 2 + 10;
    sun.target.position.copy(bounds.center);
    sun.position.copy(bounds.center).addScaledVector(towardSun, distance);
    const shadowCamera = sun.shadow.camera;
    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = radius;
    shadowCamera.bottom = -radius;
    shadowCamera.near = 0.5;
    shadowCamera.far = distance + radius + shadowLength;
    shadowCamera.updateProjectionMatrix();
    const reach = 2 * (radius + shadowLength);
    ground.scale.set(reach, reach, 1);
    ground.position.set(bounds.center.x, 0, bounds.center.z);
    if (renderer !== null) renderer.shadowMap.needsUpdate = true;
    repaint();
  };

  const layer: CustomLayerInterface = {
    id,
    type: 'custom',
    // Shares the map's depth buffer, so basemap buildings in front still hide the model.
    renderingMode: '3d',
    onAdd(map, gl) {
      renderer = new WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = PCFShadowMap;
      // Panning the map moves the camera, not the sun. The shadow map is redrawn only when either changes.
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;
      repaint = () => map.triggerRepaint();
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
    render(gl, options) {
      if (renderer === null || !visible) return;
      const projection = new Matrix4().fromArray(options.defaultProjectionData.mainMatrix as ArrayLike<number> as number[]);
      camera.projectionMatrix = projection.multiply(placement);
      const canvas = renderer.domElement;
      canvasSize = { width: canvas.clientWidth, height: canvas.clientHeight };
      renderer.resetState();
      // The shadow pass draws into its own target, then restores this viewport. Keep it the map's size.
      renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
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
        origin = model.origin;
        drawNeighbours();
      }
      // Trees belong to the previous model's frame until the new ones arrive.
      clear(trees);
      fitBounds();
    },
    setTrees(next, selectedId) {
      clear(trees);
      if (next.length > 0) trees.add(createTreeGroup(next, selectedId));
      fitBounds();
    },
    setNeighbours(blocks) {
      neighbourBlocks = blocks;
      drawNeighbours();
      fitBounds();
    },
    setHeat(overlay) {
      for (const child of [...heat.children]) {
        heat.remove(child);
        if (child instanceof Group) disposeHeatOverlay(child);
      }
      if (overlay !== null) heat.add(overlay);
      repaint();
    },
    moveTree(id, at) {
      moveTreeMesh(trees, id, at);
      if (renderer !== null) renderer.shadowMap.needsUpdate = true;
      repaint();
    },
    pick(x, y) {
      if (canvasSize === null || !visible) return { treeId: null, ground: null };
      // From canvas pixels to clip space, then back through the camera into model metres.
      const ndcX = (x / canvasSize.width) * 2 - 1;
      const ndcY = 1 - (y / canvasSize.height) * 2;
      const inverse = camera.projectionMatrix.clone().invert();
      const near = new Vector3(ndcX, ndcY, -1).applyMatrix4(inverse);
      const far = new Vector3(ndcX, ndcY, 1).applyMatrix4(inverse);
      raycaster.set(near, far.sub(near).normalize());
      let treeId: string | null = null;
      for (const hit of raycaster.intersectObject(trees, true)) {
        let node: Object3D | null = hit.object;
        while (node !== null && typeof node.userData.treeId !== 'string') node = node.parent;
        if (node !== null) {
          treeId = node.userData.treeId as string;
          break;
        }
      }
      const onGround = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
      return { treeId, ground: onGround === null ? null : { east: onGround.x, north: -onGround.z } };
    },
    setSun(next) {
      towardSun = new Vector3(next.x, next.y, next.z).normalize();
      sunUp = next.altitudeDeg > 0;
      placeSun();
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

/** Red like the map's selection. */
function paintRed(root: Group): void {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const old: Material | Material[] = node.material;
    if (Array.isArray(old)) old.forEach((item) => item.dispose());
    else old.dispose();
    node.material = new MeshLambertMaterial({ color: node.name === 'house-roof' ? ROOF_RED : WALL_RED });
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
