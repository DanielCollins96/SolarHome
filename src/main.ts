import './style.css';
import { DEMO_GABLE_HOUSE, createHouseGroup } from './house/houseMesh.ts';
import { DEMO_LOCATION } from './scene/demoLocation.ts';
import { createGround, createGroundGrid } from './scene/groundPlane.ts';
import { createNeighbourGroup } from './scene/neighbourMesh.ts';
import { createNorthArrow } from './scene/northArrow.ts';
import {
  createCamera,
  createFillLight,
  createOrbitControls,
  createRenderer,
  createScene,
  createSunLight,
  houseOrbitTarget,
  placeSun,
  resizeRenderer,
} from './scene/sceneSetup.ts';
import { shadowCardinalLabel, shadowFallDirection, solarNoonLocalMinutes, sunDirection } from './sun/sunPosition.ts';
import { parseISODate, zonedLocalToDate } from './sun/zonedTime.ts';
import { mountCompass } from './ui/compass.ts';
import { DEFAULT_CLOCK, mountControls } from './ui/controls.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) {
  throw new Error('Missing the view canvas.');
}

const clock = { ...DEFAULT_CLOCK };
const compass = mountCompass(document.body);
let updateSun = () => {};
const panel = mountControls(document.body, clock, {
  onChange: () => updateSun(),
  solarNoonMinutes: (isoDate) =>
    solarNoonLocalMinutes(isoDate, DEMO_LOCATION.latitude, DEMO_LOCATION.longitude, DEMO_LOCATION.timeZone),
});

try {
  const renderer = createRenderer(canvas);
  const scene = createScene();
  const camera = createCamera(canvas.clientWidth / Math.max(canvas.clientHeight, 1));

  const house = createHouseGroup(DEMO_GABLE_HOUSE);
  scene.add(house);
  scene.add(createGround());
  scene.add(createGroundGrid());
  scene.add(createNeighbourGroup());
  scene.add(createNorthArrow());

  const orbitTarget = houseOrbitTarget(house);
  const controls = createOrbitControls(camera, canvas, orbitTarget);
  const sunLight = createSunLight(orbitTarget);
  const fill = createFillLight();
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.add(fill);

  updateSun = () => {
    const { year, month, day } = parseISODate(clock.date);
    const hour = Math.floor(clock.minutes / 60);
    const minute = clock.minutes % 60;
    const instant = zonedLocalToDate(year, month, day, hour, minute, DEMO_LOCATION.timeZone);
    const sun = sunDirection(instant, DEMO_LOCATION.latitude, DEMO_LOCATION.longitude);
    placeSun(sunLight, sun, sun.altitudeDeg, orbitTarget);
    const shadow = shadowFallDirection(sun);
    panel.setReadout({
      altitudeDeg: sun.altitudeDeg,
      azimuthDeg: sun.azimuthDeg,
      shadowLabel: shadowCardinalLabel(shadow),
      belowHorizon: sun.altitudeDeg <= 0,
    });
  };

  const resize = () => resizeRenderer(renderer, camera, canvas);
  resize();
  window.addEventListener('resize', resize);
  updateSun();
  panel.setStatus('Drag to orbit the house. Scroll to zoom. The target stays on the house.');

  const frame = () => {
    controls.target.copy(orbitTarget);
    controls.update();
    compass.update(camera);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  };
  frame();
} catch (error) {
  const message = error instanceof Error ? error.message : 'The 3D view failed to start.';
  panel.setStatus(message);
  canvas.replaceWith(Object.assign(document.createElement('p'), { id: 'webgl-error', textContent: message }));
}
