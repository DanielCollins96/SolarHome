import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { SunVector } from '../sun/sunPosition.ts';

export function createScene(): Scene {
  const scene = new Scene();
  scene.background = new Color(0xc5d7ea);
  return scene;
}

export function createCamera(aspect: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, aspect, 0.1, 400);
  // Start south-east of the house so the south wall and its shadow are in view.
  camera.position.set(26, 16, 26);
  return camera;
}

export function createRenderer(canvas: HTMLCanvasElement): WebGLRenderer {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  return renderer;
}

/** Bounding-box center of the house. Orbit stays here and ignores neighbours. */
export function houseOrbitTarget(house: Object3D): Vector3 {
  return new Box3().setFromObject(house).getCenter(new Vector3());
}

/**
 * Orbit around the house. Pan is off so the target cannot leave the house.
 * The target is reapplied every frame as well.
 */
export function createOrbitControls(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  target: Vector3,
): OrbitControls {
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.minDistance = 8;
  controls.maxDistance = 80;
  controls.update();
  return controls;
}

/**
 * Directional sun plus a shadow map sized to the demonstration house and the
 * three nearby boxes. Ambient fill does not cast shadows; it keeps the shaded
 * side readable when the sun is low.
 */
export function createSunLight(target: Vector3): DirectionalLight {
  const sun = new DirectionalLight(0xfff2dd, 2.6);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const extent = 24;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 90;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.camera.updateProjectionMatrix();
  sun.target.position.copy(target);
  sun.target.name = 'sun-target';
  return sun;
}

/** Grow the shadow map so a larger traced or downloaded house still casts on the ground. */
export function fitSunShadow(sun: DirectionalLight, radius: number): void {
  const extent = Math.max(24, radius * 1.8);
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.far = Math.max(90, extent * 4);
  sun.shadow.camera.updateProjectionMatrix();
}

export function createFillLight(): AmbientLight {
  return new AmbientLight(0xe7eef6, 0.55);
}

/** Move the directional light along the vector toward the sun. Intensity drops to 0 below the horizon. */
export function frameHouse(camera: PerspectiveCamera, controls: OrbitControls, box: Box3): void {
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const radius = Math.max(size.x, size.y, size.z, 8) / 2;
  const fov = (camera.fov * Math.PI) / 180;
  const distance = Math.max(14, (radius / Math.sin(fov / 2)) * 1.2);
  controls.minDistance = Math.max(2, radius * 0.15);
  controls.maxDistance = Math.max(400, distance * 8);
  camera.near = Math.max(0.1, distance / 300);
  camera.far = Math.max(2000, distance * 12);
  camera.updateProjectionMatrix();
  camera.position.copy(center).add(new Vector3(1, 0.7, 1).normalize().multiplyScalar(distance));
  controls.target.copy(center);
  controls.update();
}

export function placeSun(
  sun: DirectionalLight,
  towardSun: SunVector,
  altitudeDeg: number,
  target: Vector3,
  distance = 50,
): void {
  sun.target.position.copy(target);
  if (altitudeDeg <= 0) {
    sun.intensity = 0;
    sun.position.set(target.x, target.y + distance, target.z);
    return;
  }
  sun.intensity = 2.6;
  sun.position.set(
    target.x + towardSun.x * distance,
    target.y + towardSun.y * distance,
    target.z + towardSun.z * distance,
  );
}

export function resizeRenderer(
  renderer: WebGLRenderer,
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
