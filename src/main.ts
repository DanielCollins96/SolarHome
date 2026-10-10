import './style.css';
import { Box3, Line, Mesh, PlaneGeometry, Sprite, Vector3, type Material, type Object3D } from 'three';
import { assembleBuildings, assembleHouse, assembleTrace, type GeographicBuilding } from './house/assemble.ts';
import { demoHouseModel } from './house/demoHouse.ts';
import { createHouseObject } from './house/houseMesh.ts';
import { type HouseModel } from './house/houseModel.ts';
import { createLookupCache, openIndexedDbStore, type KeyValueStore } from './geo/cache.ts';
import { GeoFailure, searchAddresses } from './geo/geocode.ts';
import { buildingContains, loadBuilding, loadBuildingUnder, loadBuildingsInBounds } from './geo/overpass.ts';
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
  createSunArrow,
  createSunLight,
  createSunMarker,
  fitSunShadow,
  frameHouse,
  houseOrbitTarget,
  placeSun,
  placeSunArrow,
  placeSunMarker,
  resizeRenderer,
} from './scene/sceneSetup.ts';
import {
  shadowCardinalLabel,
  shadowFallDirection,
  solarNoonLocalMinutes,
  solarNoonMinutesAtOffset,
  sunDirection,
  type SunDirection,
} from './sun/sunPosition.ts';
import { dateAtFixedOffset, longitudeOffsetMinutes, parseISODate, zonedLocalToDate } from './sun/zonedTime.ts';
import { mountAddressSearch } from './ui/addressSearch.ts';
import { mountCompass, mountSunBadge } from './ui/compass.ts';
import { DEFAULT_CLOCK, mountControls } from './ui/controls.ts';
import { mountMap, type AreaBounds, type PickedFootprint } from './ui/mapView.ts';

const app = document.querySelector<HTMLElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#view');
const mapHost = document.querySelector<HTMLElement>('#map');
const stage = document.querySelector<HTMLElement>('#stage');
if (!app || !canvas || !mapHost || !stage) throw new Error('The page layout is missing.');

const clock = { ...DEFAULT_CLOCK };
const compass = mountCompass(stage);
const sunBadge = mountSunBadge(stage);
let updateSun = () => {};
let showView = (_view: 'map' | 'plane') => {};
const panel = mountControls(app, clock, {
  onChange: () => updateSun(),
  solarNoonMinutes: (isoDate) => solarNoonMinutes(isoDate),
  onView: (view) => showView(view),
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
let picked: GeographicBuilding[] = [];
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
  const sunMarker = createSunMarker();
  const sunArrow = createSunArrow();
  scene.add(sunMarker);
  scene.add(sunArrow);
  scene.add(createFillLight());
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  let sunNow: SunDirection | null = null;

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
    onBuildings: (buildings, mode) => {
      applyPicked(buildings, mode);
    },
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
    sunNow = sun;
    placeSun(sunLight, sun, sun.altitudeDeg, orbitTarget, Math.max(50, viewRadius * 4));
    placeSunMarker(sunMarker, sun, sun.altitudeDeg, orbitTarget, camera);
    placeSunArrow(sunArrow, sun, sun.altitudeDeg, orbitTarget, Math.max(16, viewRadius * 2.4));
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
    if (options.syncMap) {
      map.setFootprints(next.parts.map((part) => unprojectRing(part.footprint, next.origin)));
    }
    if (options.fly) map.flyTo(next.origin.longitude, next.origin.latitude);
    updateSun();
    if (options.announce === false) return;
    const warning = built.warnings[0];
    panel.setStatus(warning ?? `${next.label}. Left-drag moves the view. Right-drag turns it.`);
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

  let pickBusy = false;

  async function runPick(point: { latitude: number; longitude: number }): Promise<void> {
    if (pickBusy) return;
    const existing = picked.findIndex((building) => buildingContains(building, point.latitude, point.longitude));
    if (existing >= 0) {
      picked.splice(existing, 1);
      showPicked(picked.length === 0 ? 'Selection cleared.' : 'Removed that building.');
      return;
    }
    pickBusy = true;
    address.setBusy(true);
    address.setMessage('Adding that building…');
    try {
      const building = await loadBuildingUnder(point.latitude, point.longitude, { fetch, cache });
      picked = picked.filter((item) => item.id !== building.id);
      picked.push(building);
      showPicked('Added that building.');
    } catch (error) {
      address.setMessage(failureText(error));
    } finally {
      pickBusy = false;
      address.setBusy(false);
    }
  }

  function showPicked(note: string, fly = false): void {
    if (picked.length === 0) {
      map.setFootprints([]);
      address.setMessage('Nothing selected. Click a building to start, or shift-drag a box.');
      return;
    }
    model = assembleBuildings(picked);
    site = { latitude: model.origin.latitude, longitude: model.origin.longitude, timeZone: null, label: model.label };
    describeSite(`${model.label}. Time uses a fixed offset from longitude, without daylight saving.`);
    showHouse(model, { syncMap: true, fly, demo: false, announce: false });
    const count = picked.length === 1 ? '1 building' : `${picked.length} buildings`;
    const message = `${count}. ${note} Click another to add it, or click a red one to remove it.`;
    address.setMessage(message);
    map.setNote(message);
  }

  async function runArea(bounds: AreaBounds): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading the buildings in that box…');
    try {
      picked = await loadBuildingsInBounds(bounds, { fetch, cache });
      showPicked('Box selection replaced the previous buildings.');
    } catch (error) {
      address.setMessage(failureText(error));
      map.setNote(failureText(error));
    } finally {
      map.clearSelectionBox();
      address.setBusy(false);
    }
  }

  function applyPicked(buildings: PickedFootprint[], mode: 'replace' | 'toggle'): void {
    const next = buildings.map(footprintToBuilding);
    if (mode === 'replace') {
      picked = next;
      showPicked(picked.length === 1 ? 'Selected that building.' : 'Selected the buildings in the box.', true);
      return;
    }
    let added = false;
    for (const building of next) {
      const index = picked.findIndex((item) => sameBuilding(item, building));
      if (index >= 0) picked.splice(index, 1);
      else {
        picked.push(building);
        added = true;
      }
    }
    showPicked(added ? 'Added that building.' : 'Removed that building.');
  }

  async function runSelect(hit: { label: string; latitude: number; longitude: number; osmType: 'node' | 'way' | 'relation'; osmId: number }): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading the building footprint…');
    map.previewPlace(hit.longitude, hit.latitude);
    try {
      const building = await loadBuilding(hit, { fetch, cache });
      picked = [building];
      model = assembleHouse(building);
      site = { latitude: model.origin.latitude, longitude: model.origin.longitude, timeZone: null, label: hit.label };
      describeSite(`${hit.label}. Time uses a fixed offset from longitude, without daylight saving.`);
      map.setOsmRing(building.parts[0]?.outer ?? []);
      showHouse(model, { syncMap: true, fly: true, demo: false });
      address.setMessage('1 building. Click another to add it, or click this one to remove it.');
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
  panel.setStatus('Click buildings to add or remove them. Shift-drag a box to select a whole block.');

  showView = (view) => {
    const mapMain = view === 'map';
    panel.setView(view);
    mapHost.classList.toggle('primary', mapMain);
    mapHost.classList.toggle('inset', !mapMain);
    stage.classList.toggle('primary', !mapMain);
    stage.classList.toggle('inset', mapMain);
    requestAnimationFrame(() => {
      map.resize();
      resizeRenderer(renderer, camera, canvas);
      frameHouse(camera, controls, new Box3().setFromObject(house));
    });
  };
  mapHost.addEventListener('click', () => {
    if (mapHost.classList.contains('inset')) showView('map');
  });
  stage.addEventListener('click', () => {
    if (stage.classList.contains('inset')) showView('plane');
  });
  showView('map');

  const frame = () => {
    controls.update();
    if (sunNow !== null) {
      placeSunMarker(sunMarker, sunNow, sunNow.altitudeDeg, orbitTarget, camera);
      compass.update(camera, sunNow);
      sunBadge.update(camera, sunNow, orbitTarget, canvas.clientWidth, canvas.clientHeight);
    }
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

function footprintToBuilding(footprint: PickedFootprint): GeographicBuilding {
  return {
    id: footprint.id,
    label: footprint.label,
    tags: {
      building: 'yes',
      ...(footprint.heightM === null ? {} : { height: String(footprint.heightM) }),
    },
    parts: [{ outer: footprint.outer, holes: footprint.holes }],
    provenance: { source: 'osm', confidence: 0.75, note: 'Building drawn on the map.' },
  };
}

function sameBuilding(a: GeographicBuilding, b: GeographicBuilding): boolean {
  if (a.id === b.id) return true;
  const aId = a.id.split('/').pop();
  const bId = b.id.split('/').pop();
  return aId !== undefined && aId !== '' && aId === bId;
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
