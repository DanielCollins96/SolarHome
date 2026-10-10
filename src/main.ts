import './style.css';
import { Box3, Line, Mesh, PlaneGeometry, Sprite, Vector3, type Material, type Object3D } from 'three';
import { assembleBuildings, assembleHouse, assembleTrace } from './house/assemble.ts';
import { demoHouseModel } from './house/demoHouse.ts';
import { createHouseObject } from './house/houseMesh.ts';
import { withEaveHeight, withOrientation, withRoof, type HouseModel } from './house/houseModel.ts';
import { createLookupCache, openIndexedDbStore, type KeyValueStore } from './geo/cache.ts';
import { GeoFailure, searchAddresses } from './geo/geocode.ts';
import { loadBuilding, loadBuildingsInBounds } from './geo/overpass.ts';
import { unprojectRing } from './geo/projection.ts';
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
  fitSunShadow,
  frameHouse,
  houseOrbitTarget,
  placeSun,
  resizeRenderer,
} from './scene/sceneSetup.ts';
import {
  shadowCardinalLabel,
  shadowFallDirection,
  solarNoonLocalMinutes,
  solarNoonMinutesAtOffset,
  sunDirection,
} from './sun/sunPosition.ts';
import { dateAtFixedOffset, longitudeOffsetMinutes, parseISODate, zonedLocalToDate } from './sun/zonedTime.ts';
import { mountAddressSearch } from './ui/addressSearch.ts';
import { mountCompass } from './ui/compass.ts';
import { DEFAULT_CLOCK, mountControls } from './ui/controls.ts';
import { mountMap, type AreaBounds } from './ui/mapView.ts';
import { mountQualityPanel } from './ui/qualityPanel.ts';

const app = document.querySelector<HTMLElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#view');
const mapHost = document.querySelector<HTMLElement>('#map');
const stage = document.querySelector<HTMLElement>('#stage');
if (!app || !canvas || !mapHost || !stage) throw new Error('The page layout is missing.');

const clock = { ...DEFAULT_CLOCK };
const compass = mountCompass(stage);
let updateSun = () => {};
const panel = mountControls(app, clock, {
  onChange: () => updateSun(),
  solarNoonMinutes: (isoDate) => solarNoonMinutes(isoDate),
});

let persistent: KeyValueStore | undefined;
const cache = createLookupCache({
  get: (key) => (persistent === undefined ? Promise.resolve(undefined) : persistent.get(key)),
  set: (key, value) => (persistent === undefined ? Promise.resolve() : persistent.set(key, value)),
});
void openIndexedDbStore()
  .then((store) => {
    persistent = store;
  })
  .catch(() => {
    panel.setStatus('This browser could not open the lookup cache. Searches still work for this session.');
  });

interface Site {
  latitude: number;
  longitude: number;
  timeZone: string | null;
  label: string;
}

let site: Site = {
  latitude: DEMO_LOCATION.latitude,
  longitude: DEMO_LOCATION.longitude,
  timeZone: DEMO_LOCATION.timeZone,
  label: DEMO_LOCATION.name,
};
let model = demoHouseModel();
let viewRadius = 12;
let searchToken = 0;
const searchAbort = { current: new AbortController() };

function solarNoonMinutes(isoDate: string): number {
  if (site.timeZone !== null) {
    return solarNoonLocalMinutes(isoDate, site.latitude, site.longitude, site.timeZone);
  }
  return solarNoonMinutesAtOffset(isoDate, site.latitude, site.longitude, longitudeOffsetMinutes(site.longitude));
}

try {
  const renderer = createRenderer(canvas);
  const scene = createScene();
  const camera = createCamera(canvas.clientWidth / Math.max(canvas.clientHeight, 1));
  let house = createHouseObject(model).group;
  scene.add(house);
  let ground = createGround();
  let grid = createGroundGrid();
  scene.add(ground);
  scene.add(grid);
  const neighbours = createNeighbourGroup();
  scene.add(neighbours);
  let arrow = createNorthArrow();
  scene.add(arrow);

  const orbitTarget = houseOrbitTarget(house);
  const controls = createOrbitControls(camera, canvas, orbitTarget);
  const sunLight = createSunLight(orbitTarget);
  scene.add(sunLight);
  scene.add(sunLight.target);
  scene.add(createFillLight());

  const map = mountMap(mapHost, {
    longitude: site.longitude,
    latitude: site.latitude,
    onTrace: (ring) => {
      model = assembleTrace(ring, model);
      showHouse(model, { syncMap: false, fly: false, demo: false, announce: false });
    },
    onPick: (point) => {
      void runPick(point);
    },
    onArea: (bounds) => {
      void runArea(bounds);
    },
  });

  const quality = mountQualityPanel(panel.tools, {
    onEave: (meters) => {
      model = withEaveHeight(model, meters);
      showHouse(model, { syncMap: false, fly: false, demo: false });
    },
    onRoof: (roof) => {
      model = withRoof(model, roof);
      showHouse(model, { syncMap: false, fly: false, demo: false });
    },
    onOrientation: (degrees) => {
      model = withOrientation(model, degrees);
      showHouse(model, { syncMap: false, fly: false, demo: false });
    },
    onTracing: (tracing) => {
      map.setTracing(tracing);
      panel.setStatus(
        tracing
          ? 'Click to add a corner, drag a corner, click an edge to split it, right-click a corner to delete it.'
          : 'Outline editing is off, so the map can pan.',
      );
    },
    onOpacity: (opacity) => map.setOpacity(opacity),
    onNewOutline: () => {
      map.setTrace([]);
      panel.setStatus('Click the map to start a new outline. The house updates once it has three corners.');
    },
    onImport: (imported) => {
      model = imported;
      site = {
        latitude: imported.origin.latitude,
        longitude: imported.origin.longitude,
        timeZone: null,
        label: imported.label,
      };
      describeSite('Imported house. Time uses a fixed offset from longitude, without daylight saving.');
      map.setOsmRing([]);
      showHouse(model, { syncMap: true, fly: true, demo: false });
    },
    houseObject: () => house,
  });

  const address = mountAddressSearch(panel.tools, {
    onSearch: (query) => {
      void runSearch(query);
    },
    onSelect: (hit) => {
      void runSelect(hit);
    },
  });

  updateSun = () => {
    const { year, month, day } = parseISODate(clock.date);
    const hour = Math.floor(clock.minutes / 60);
    const minute = clock.minutes % 60;
    const instant =
      site.timeZone === null
        ? dateAtFixedOffset(year, month, day, hour, minute, longitudeOffsetMinutes(site.longitude))
        : zonedLocalToDate(year, month, day, hour, minute, site.timeZone);
    const sun = sunDirection(instant, site.latitude, site.longitude);
    placeSun(sunLight, sun, sun.altitudeDeg, orbitTarget, Math.max(50, viewRadius * 4));
    const shadow = shadowFallDirection(sun);
    panel.setReadout({
      altitudeDeg: sun.altitudeDeg,
      azimuthDeg: sun.azimuthDeg,
      shadowLabel: shadowCardinalLabel(shadow),
      belowHorizon: sun.altitudeDeg <= 0,
    });
  };

  function showHouse(next: HouseModel, options: { syncMap: boolean; fly: boolean; demo: boolean; announce?: boolean }): void {
    const built = createHouseObject(next);
    scene.remove(house);
    disposeObject(house);
    house = built.group;
    scene.add(house);
    orbitTarget.copy(houseOrbitTarget(house));
    const box = new Box3().setFromObject(house);
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.y, size.z, 8) / 2;
    viewRadius = radius;
    frameHouse(camera, controls, box);
    fitSunShadow(sunLight, radius);
    const groundSize = Math.max(48, radius * 8);
    ground.geometry.dispose();
    ground.geometry = new PlaneGeometry(groundSize, groundSize);
    scene.remove(grid);
    disposeObject(grid);
    grid = createGroundGrid(groundSize);
    scene.add(grid);
    scene.remove(arrow);
    disposeObject(arrow);
    arrow = createNorthArrow(box.max.z);
    scene.add(arrow);
    neighbours.visible = options.demo;
    quality.setModel(next);
    if (options.syncMap) {
      map.setFootprints(next.parts.map((part) => unprojectRing(part.footprint, next.origin)));
    }
    if (options.fly) map.flyTo(next.origin.longitude, next.origin.latitude);
    updateSun();
    if (options.announce === false) return;
    const warning = built.warnings[0];
    panel.setStatus(warning ?? `${next.label}. Drag the 3D view to orbit. Scroll to zoom.`);
  }

  async function runSearch(query: string): Promise<void> {
    const token = ++searchToken;
    if (query.trim().replace(/\s+/g, ' ').length < 3) {
      address.setResults([]);
      address.setMessage('Type at least 3 letters, then pick a result.');
      return;
    }
    searchAbort.current.abort();
    searchAbort.current = new AbortController();
    address.setBusy(true);
    try {
      const hits = await searchAddresses(query, { fetch, cache, signal: searchAbort.current.signal });
      if (token !== searchToken) return;
      address.setResults(hits);
      address.setMessage(
        hits.length === 0 && query.trim().length >= 3 ? 'No address matched that search.' : 'Pick a result, or press Enter for the first one.',
      );
    } catch (error) {
      if (token !== searchToken) return;
      address.setResults([]);
      address.setMessage(failureText(error));
    } finally {
      if (token === searchToken) address.setBusy(false);
    }
  }

  async function runPick(point: { latitude: number; longitude: number }): Promise<void> {
    await runSelect({
      label: 'Selected building',
      latitude: point.latitude,
      longitude: point.longitude,
      osmType: 'node',
      osmId: 0,
    });
  }

  async function runArea(bounds: AreaBounds): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading the buildings in that box…');
    try {
      const buildings = await loadBuildingsInBounds(bounds, { fetch, cache });
      model = assembleBuildings(buildings);
      site = { latitude: model.origin.latitude, longitude: model.origin.longitude, timeZone: null, label: model.label };
      describeSite(`${model.label}. Time uses a fixed offset from longitude, without daylight saving.`);
      showHouse(model, { syncMap: true, fly: true, demo: false });
      address.setMessage(`${buildings.length} buildings. Shift-drag to select another area.`);
    } catch (error) {
      address.setMessage(failureText(error));
    } finally {
      address.setBusy(false);
    }
  }

  async function runSelect(hit: { label: string; latitude: number; longitude: number; osmType: 'node' | 'way' | 'relation'; osmId: number }): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading the building footprint…');
    map.previewPlace(hit.longitude, hit.latitude);
    try {
      const building = await loadBuilding(hit, { fetch, cache });
      model = assembleHouse(building);
      site = { latitude: model.origin.latitude, longitude: model.origin.longitude, timeZone: null, label: hit.label };
      describeSite(`${hit.label}. Time uses a fixed offset from longitude, without daylight saving.`);
      map.setOsmRing(building.parts[0]?.outer ?? []);
      showHouse(model, { syncMap: true, fly: true, demo: false });
      address.setMessage('');
    } catch (error) {
      address.setMessage(failureText(error));
    } finally {
      address.setBusy(false);
    }
  }

  const resize = () => {
    resizeRenderer(renderer, camera, canvas);
    map.resize();
  };
  resize();
  window.addEventListener('resize', resize);
  showHouse(model, { syncMap: true, fly: true, demo: true });
  panel.setStatus('Shift-drag a box on the map to load the buildings there. Click one building to load only that one.');

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

function describeSite(lede: string): void {
  const zone =
    site.timeZone ??
    `UTC${formatOffset(longitudeOffsetMinutes(site.longitude))} (no daylight saving)`;
  const lat = Math.abs(site.latitude).toFixed(4);
  const lng = Math.abs(site.longitude).toFixed(4);
  panel.setSite(lede, `${lat}°${site.latitude >= 0 ? 'N' : 'S'}, ${lng}°${site.longitude >= 0 ? 'E' : 'W'} · ${zone}`);
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '−';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function failureText(error: unknown): string {
  if (error instanceof GeoFailure) return error.message;
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return error instanceof Error ? error.message : 'The lookup failed.';
}

function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (child instanceof Mesh || child instanceof Line || child instanceof Sprite) {
      child.geometry.dispose();
      const material: Material | Material[] = child.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    }
  });
}
