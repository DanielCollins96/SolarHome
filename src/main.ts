import './style.css';
import { Box3, Group, Line, Mesh, PlaneGeometry, Sprite, Vector3, type Material, type Object3D } from 'three';
import { assembleBuildings, assembleHouse, assembleTrace, type GeographicBuilding } from './house/assemble.ts';
import { demoHouseModel } from './house/demoHouse.ts';
import { createHouseObject } from './house/houseMesh.ts';
import { type HouseModel } from './house/houseModel.ts';
import { createLookupCache, openIndexedDbStore, type KeyValueStore } from './geo/cache.ts';
import { GeoFailure, searchAddresses } from './geo/geocode.ts';
import { buildingContains, loadBuilding, loadBuildingsInBounds, loadWholeBuilding } from './geo/overpass.ts';
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
const cacheReady = openIndexedDbStore()
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
const knownBuildings: GeographicBuilding[] = [];
let openingDone: Promise<void> = Promise.resolve();
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
  let house = new Group();
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
    onBuilding: (parts) => {
      selectRendered(parts);
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
    onClear: () => {
      picked = [];
      showPicked('Selection cleared.');
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

  function replaceHouse(next: Group): void {
    scene.remove(house);
    disposeObject(house);
    house = next;
    scene.add(house);
  }

  function showHouse(next: HouseModel, options: { syncMap: boolean; fly: boolean; demo: boolean; announce?: boolean }): void {
    const built = createHouseObject(next);
    replaceHouse(built.group);
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
    neighbours.visible = false;
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
  let upgradeToken = 0;

  function selectRendered(parts: PickedFootprint[]): void {
    const first = parts[0];
    if (first === undefined) return;
    const center = ringCentroid(first.outer);
    const known = parts
      .map((part) => ringCentroid(part.outer))
      .map((point) => knownBuildingAt(point.latitude, point.longitude))
      .find((building) => building !== undefined);
    const building = known ?? partsToBuilding(parts);
    const index = picked.findIndex(
      (item) => sameBuilding(item, building) || buildingContains(item, center.latitude, center.longitude),
    );
    if (index >= 0) {
      picked.splice(index, 1);
      showPicked(picked.length === 0 ? 'Selection cleared.' : 'Removed that building.');
      return;
    }
    picked = picked.filter((item) => !sameBuilding(item, building) && !coveredBy(building, item));
    picked.push(building);
    showPicked('Selected that building.');
    if (known === undefined) void upgradeSelection(building, ++upgradeToken);
  }

  async function upgradeSelection(placeholder: GeographicBuilding, token: number): Promise<void> {
    const center = ringCentroid(placeholder.parts[0]?.outer ?? []);
    try {
      const whole = await loadWholeBuilding(center.latitude, center.longitude, { fetch, cache });
      if (token !== upgradeToken || !buildingContains(whole, center.latitude, center.longitude)) return;
      if (!picked.some((item) => sameBuilding(item, placeholder))) return;
      rememberBuilding(whole);
      picked = picked.filter((item) => !sameBuilding(item, placeholder) && !coveredBy(whole, item));
      picked.push(whole);
      showPicked('Selected that building.');
    } catch {
      // The map outline is already selected. A busy lookup must not wipe it.
    }
  }

  async function runPick(point: { latitude: number; longitude: number }): Promise<void> {
    if (pickBusy) return;
    await openingDone;
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
      const known = knownBuildingAt(point.latitude, point.longitude);
      const building = known ?? (await loadWholeBuilding(point.latitude, point.longitude, { fetch, cache }));
      if (!buildingContains(building, point.latitude, point.longitude)) {
        address.setMessage('Click on a building. A click between houses does not select a neighbor.');
        return;
      }
      rememberBuilding(building);
      picked = picked.filter((item) => !sameBuilding(item, building) && !coveredBy(building, item));
      picked.push(building);
      showPicked('Selected that building.');
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
      map.setNote('');
      replaceHouse(new Group());
      address.setClearEnabled(false);
      address.setMessage('Nothing selected. Click a building to start, or shift-drag a box.');
      return;
    }
    address.setClearEnabled(true);
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
    void resolvePicked(buildings, mode);
  }

  async function resolvePicked(buildings: PickedFootprint[], mode: 'replace' | 'toggle'): Promise<void> {
    await openingDone;
    const next = uniqueBuildings(buildings.map(resolveFootprint));
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

  async function selectOpeningBuilding(): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading Toronto City Hall…');
    await cacheReady;
    try {
      const building = await loadWholeBuilding(DEMO_LOCATION.latitude, DEMO_LOCATION.longitude, { fetch, cache });
      rememberBuilding(building);
      picked = [building];
      model = assembleHouse(building);
      site = {
        latitude: model.origin.latitude,
        longitude: model.origin.longitude,
        timeZone: DEMO_LOCATION.timeZone,
        label: building.label,
      };
      describeSite(building.label);
      showHouse(model, { syncMap: true, fly: true, demo: false, announce: false });
      const message = `1 building. ${building.label}. Click another to add it, or click this one to remove it.`;
      address.setClearEnabled(true);
      address.setMessage(message);
      map.setNote(message);
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
      picked = [building];
      model = assembleHouse(building);
      site = { latitude: model.origin.latitude, longitude: model.origin.longitude, timeZone: null, label: hit.label };
      describeSite(`${hit.label}. Time uses a fixed offset from longitude, without daylight saving.`);
      map.setOsmRing(building.parts[0]?.outer ?? []);
      showHouse(model, { syncMap: true, fly: true, demo: false });
      address.setClearEnabled(true);
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
  openingDone = selectOpeningBuilding();
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

function partsToBuilding(parts: PickedFootprint[]): GeographicBuilding {
  const outline = parts[0];
  if (outline === undefined) return footprintToBuilding({ id: 'building/empty', label: 'Building', outer: [], holes: [], heightM: null });
  const named = parts.find((part) => part.label !== 'Building');
  return {
    id: outline.id,
    label: named?.label ?? outline.label,
    tags: { building: 'yes' },
    parts: parts.map((part) => ({
      outer: part.outer,
      holes: part.holes,
      tags: part.heightM === null ? undefined : { height: String(part.heightM) },
    })),
    provenance: { source: 'osm', confidence: 0.75, note: 'Building drawn on the map.' },
  };
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

function rememberBuilding(building: GeographicBuilding): void {
  if (knownBuildings.some((item) => item.id === building.id)) return;
  knownBuildings.push(building);
}

function resolveFootprint(footprint: PickedFootprint): GeographicBuilding {
  const center = ringCentroid(footprint.outer);
  return knownBuildingAt(center.latitude, center.longitude) ?? footprintToBuilding(footprint);
}

function coveredBy(whole: GeographicBuilding, piece: GeographicBuilding): boolean {
  const ring = piece.parts[0]?.outer;
  if (ring === undefined || ring.length === 0) return false;
  const center = ringCentroid(ring);
  return buildingContains(whole, center.latitude, center.longitude);
}

function knownBuildingAt(latitude: number, longitude: number): GeographicBuilding | undefined {
  return knownBuildings.find((building) => buildingContains(building, latitude, longitude));
}

function ringCentroid(ring: readonly { latitude: number; longitude: number }[]): { latitude: number; longitude: number } {
  const latitude = ring.reduce((sum, point) => sum + point.latitude, 0) / ring.length;
  const longitude = ring.reduce((sum, point) => sum + point.longitude, 0) / ring.length;
  return { latitude, longitude };
}

function uniqueBuildings(buildings: GeographicBuilding[]): GeographicBuilding[] {
  const result: GeographicBuilding[] = [];
  for (const building of buildings) {
    if (!result.some((item) => sameBuilding(item, building))) result.push(building);
  }
  return result;
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
