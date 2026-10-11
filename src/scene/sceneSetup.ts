import {
  AmbientLight,
  Box3,
  BoxGeometry,
  Color,
  ConeGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
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
 * Same gestures as the map: left-drag moves the view, right-drag turns it,
 * scroll zooms. Pan is in screen space so a left drag slides the ground
 * the way the map does.
 */
export function createOrbitControls(
  camera: PerspectiveCamera,
  canvas: HTMLCanvasElement,
  target: Vector3,
): OrbitControls {
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.mouseButtons = {
    LEFT: MOUSE.PAN,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.ROTATE,
  };
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.minDistance = 8;
  controls.maxDistance = 80;
  controls.update();
  return controls;
}

/** Bright disc kept in front of the camera so the sun reads as a place in the sky. */
export function createSunMarker(): Group {
  const marker = new Group();
  marker.name = 'sun-marker';
  const glow = new Mesh(
    new SphereGeometry(1.7, 24, 16),
    new MeshBasicMaterial({
      color: 0xfff3b0,
      transparent: true,
      opacity: 0.45,
      toneMapped: false,
      depthWrite: false,
    }),
  );
  const disc = new Mesh(
    new SphereGeometry(1, 24, 16),
    new MeshBasicMaterial({ color: 0xffd23a, toneMapped: false }),
  );
  marker.add(glow);
  marker.add(disc);
  return marker;
}

/** Thick ground arrow. Local +X points toward the sun. */
export function createSunArrow(): Group {
  const arrow = new Group();
  arrow.name = 'sun-arrow';
  const material = new MeshBasicMaterial({ color: 0xffc107, toneMapped: false });
  const shaft = new Mesh(new BoxGeometry(1, 1, 1), material);
  const head = new Mesh(new ConeGeometry(1, 1, 16), material);
  head.rotation.z = -Math.PI / 2;
  arrow.add(shaft);
  arrow.add(head);
  return arrow;
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
  if (box.isEmpty()) return;
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

/** Park the disc along the sun vector, sized so it stays obvious as you zoom. */
export function placeSunMarker(
  marker: Object3D,
  towardSun: SunVector,
  altitudeDeg: number,
  target: Vector3,
  camera: PerspectiveCamera,
): void {
  marker.visible = altitudeDeg > 0;
  if (!marker.visible) return;
  const distance = Math.max(16, camera.position.distanceTo(target) * 0.78);
  marker.position.set(
    target.x + towardSun.x * distance,
    target.y + towardSun.y * distance,
    target.z + towardSun.z * distance,
  );
  marker.scale.setScalar(distance * 0.12);
}

const sunArrowAxis = new Vector3(1, 0, 0);
const sunArrowDirection = new Vector3();
const sunArrowTurn = new Quaternion();

/** Point the ground arrow at the sun, starting outside the building. Hidden when the sun is down. */
export function placeSunArrow(
  arrow: Group,
  towardSun: SunVector,
  altitudeDeg: number,
  target: Vector3,
  length: number,
): void {
  const horizontal = Math.hypot(towardSun.x, towardSun.z);
  arrow.visible = altitudeDeg > 0 && horizontal > 1e-4;
  if (!arrow.visible) return;
  const shaft = arrow.children[0];
  const head = arrow.children[1];
  if (shaft === undefined || head === undefined) return;
  const reach = Math.max(10, length * 0.7);
  shaft.scale.set(reach, 1.6, 1.6);
  shaft.position.set(reach / 2, 0, 0);
  head.scale.set(2.4, 3.2, 2.4);
  head.position.set(reach + 1.6, 0, 0);
  sunArrowDirection.set(towardSun.x / horizontal, 0, towardSun.z / horizontal);
  arrow.position.copy(target).addScaledVector(sunArrowDirection, length * 0.35);
  arrow.position.y = 0.9;
  arrow.quaternion.copy(sunArrowTurn.setFromUnitVectors(sunArrowAxis, sunArrowDirection));
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
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
