import './style.css';
import { Box3, Group, Line, Mesh, MeshLambertMaterial, Plane, PlaneGeometry, Raycaster, Sprite, Vector2, Vector3, type Material, type Object3D } from 'three';
import { assembleBuildings, assembleHouse, assembleTrace, type GeographicBuilding } from './house/assemble.ts';
import { demoHouseModel } from './house/demoHouse.ts';
import { createHouseObject, partTopHeight } from './house/houseMesh.ts';
import { type HouseModel } from './house/houseModel.ts';
import { createLookupCache, openIndexedDbStore, type KeyValueStore } from './geo/cache.ts';
import { GeoFailure, reverseGeocode, searchAddresses } from './geo/geocode.ts';
import { inCalgary, lacksHeight, loadCalgaryCanopy, loadCalgaryTrees, type ListedTree, withCalgaryHeights } from './geo/calgary.ts';
import { buildingContains, loadBuilding, loadBuildingsInBounds, loadWholeBuilding } from './geo/overpass.ts';
import { localToLngLat, projectRing, projectToLocal, unprojectRing, type LngLat } from './geo/projection.ts';
import { DEMO_LOCATION } from './scene/demoLocation.ts';
import { createGround, createGroundGrid } from './scene/groundPlane.ts';
import { createNeighbourGroup } from './scene/neighbourMesh.ts';
import { createNorthArrow } from './scene/northArrow.ts';
import { createSavedPlaces, samePlace, type SavedPlace } from './scene/savedPlaces.ts';
import { createTreeEdits, MAX_TREE_HEIGHT_M, MAX_TREE_WIDTH_M, MIN_TREE_HEIGHT_M, MIN_TREE_WIDTH_M, type PlacedTree } from './scene/treeEdits.ts';
import { createTreeGroup, moveTreeMesh, planTrees, treeHeightOf, type TreeCrown, type TreeKind, type TreePoint } from './scene/treeMesh.ts';
import type { PlanPoint } from './house/centering.ts';
import { pointInRing } from './house/planGeometry.ts';
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
import { dateAtFixedOffset, longitudeOffsetMinutes, parseISODate, timeZoneAt, zonedLocalToDate } from './sun/zonedTime.ts';
import { mountAddressSearch } from './ui/addressSearch.ts';
import { mountPlacesPanel } from './ui/placesPanel.ts';
import { mountTreeEditor } from './ui/treeEditor.ts';
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

const places = createSavedPlaces();
/** A saved home opens instead of the demonstration building. */
const startHome = places.home();
let site: Site =
  startHome === null
    ? { latitude: DEMO_LOCATION.latitude, longitude: DEMO_LOCATION.longitude, timeZone: DEMO_LOCATION.timeZone, label: DEMO_LOCATION.name }
    : { ...siteAt(startHome.at), label: startHome.label };
let model = demoHouseModel();
let picked: GeographicBuilding[] = [];
const knownBuildings: GeographicBuilding[] = [];
/** Trees are drawn this far around the selection: the yard and the next one over, where shade matters most. */
const TREE_REACH_M = 25;
/** A selection wider than this, trees included, is a district rather than a home and its street. */
const MAX_TREE_AREA_M = 600;
/** Crown width of a newly planted tree, about a young mountain ash. */
const NEW_TREE_WIDTH_M = 5;
/** Buildings already looked up in the City of Calgary's heights, by id, with any height it added. */
const cityChecked = new Map<string, GeographicBuilding>();
let openingDone: Promise<void> = Promise.resolve();
/** Set once the person selects anything, so the slow opening lookup does not replace their choice. */
let userSelected = false;
let viewRadius = 12;
/** Half the width the sun's shadow must cover: the model, and its trees once they load. */
let shadowRadius = 12;
let searchToken = 0;
/** The name the selection came with, from an address search or a saved place. Null names it from the buildings. */
let placeLabel: string | null = null;
/** Seconds of quiet after a change before the selection goes into the recent places. */
const VISIT_DELAY_MS = 1_500;
let visitTimer = 0;
const searchAbort = { current: new AbortController() };

/** Farther than this from the selection, a building or the map's centre is somewhere else entirely. */
const DISTANT_SELECTION_M = 8_000;

const FIXED_OFFSET_NOTE = 'Time uses a fixed offset from longitude, without daylight saving.';

/** The place's own time zone, so the clock matches local time including daylight saving. */
function siteAt(origin: { latitude: number; longitude: number }): Omit<Site, 'label'> {
  return { latitude: origin.latitude, longitude: origin.longitude, timeZone: timeZoneAt(origin.latitude, origin.longitude) };
}

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
  let trees = new Group();
  scene.add(trees);
  let treeToken = 0;
  /** The city's trees around the current model, before the person's edits. */
  let cityTrees: PlacedTree[] = [];
  let treeOrigin: LngLat | null = null;
  let selectedTreeId: string | null = null;
  let draggedTree: { id: string; to: PlanPoint | null } | null = null;
  const treeEdits = createTreeEdits();
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
    onBuildings: (buildings) => {
      selectBox(buildings);
    },
    onMove: (center) => {
      releaseDistantSelection(center);
    },
    onPlainClick: (hit) => clickTrees(hit),
    treeDrag: {
      start: (hit) => startTreeDrag(hit.treeId),
      move: (ground) => dragTree(ground),
      end: (moved) => endTreeDrag(moved),
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

  const placesPanel = mountPlacesPanel(panel.tools, {
    onGo: (place) => goToPlace(place),
    onSaveHome: () => {
      void saveHome();
    },
    onForgetHome: () => {
      places.clearHome();
      refreshPlaces();
      address.setMessage('Home forgotten.');
    },
    onToggleSaved: () => {
      void toggleSaved();
    },
    onUnsave: (place) => {
      places.unsave(place.id);
      refreshPlaces();
    },
    onForget: (place) => {
      places.forget(place.id);
      refreshPlaces();
    },
  });
  refreshPlaces();

  const treeEditor = mountTreeEditor(panel.tools, {
    onToggle: (editing) => {
      map.setNote(editing ? 'Editing trees. Click a tree to resize it, drag it to move it, or click open ground to plant one.' : '');
      selectTree(null);
    },
    onKind: (kind) => editSelectedTree({ kind }),
    onWidth: (factor) => {
      const tree = selectedTree();
      if (tree === undefined) return;
      editSelectedTree({ widthM: Math.min(MAX_TREE_WIDTH_M, Math.max(MIN_TREE_WIDTH_M, tree.widthM * factor)) });
    },
    onHeight: (factor) => {
      const tree = selectedTree();
      if (tree === undefined) return;
      editSelectedTree({ heightM: Math.min(MAX_TREE_HEIGHT_M, Math.max(MIN_TREE_HEIGHT_M, treeHeightOf(tree) * factor)) });
    },
    onRemove: () => editSelectedTree({ removed: true }),
    onReset: () => {
      if (treeOrigin !== null) treeEdits.resetAround(treeOrigin, MAX_TREE_AREA_M);
      selectTree(null);
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
    map.setSun(sun);
    // Far enough out that trees on the sun's side are still between the light and the house.
    placeSun(sunLight, sun, sun.altitudeDeg, orbitTarget, Math.max(50, viewRadius * 4, shadowRadius * 3));
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
    shadowRadius = radius;
    const groundSize = Math.max(48, radius * 8);
    ground.geometry.dispose();
    ground.geometry = new PlaneGeometry(groundSize, groundSize);
    scene.remove(grid);
    disposeObject(grid);
    // A 2 m grid over a whole district would be millions of lines. Past 2 km the grid stays put.
    grid = createGroundGrid(Math.min(groundSize, 2_000));
    scene.add(grid);
    scene.remove(arrow);
    disposeObject(arrow);
    arrow = createNorthArrow(box.max.z);
    scene.add(arrow);
    neighbours.visible = false;
    void showTrees(next);
    if (options.syncMap) {
      map.setModel(next);
      map.setFootprints(
        next.parts.map((part) => ({
          ring: unprojectRing(part.footprint, next.origin),
          heightM: partTopHeight(part),
          baseM: part.baseHeightM ?? 0,
        })),
      );
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
    // Only the piece under the cursor says which loaded building was clicked. Its touching
    // neighbours can include another landmark, like the Calgary Tower within Tower Centre.
    const known = knownBuildingIn([first]);
    const building = known ?? partsToBuilding(parts);
    // A building far from the current selection starts a new one. Joining two cities into one
    // model would put them thousands of kilometres apart in a single scene.
    const away = projectToLocal(center, model.origin);
    if (picked.length > 0 && Math.hypot(away.east, away.north) > DISTANT_SELECTION_M) picked = [];
    const index = picked.findIndex((item) => sameBuilding(item, building) || holds(item, first.outer));
    if (index >= 0) {
      picked.splice(index, 1);
      showPicked(picked.length === 0 ? 'Selection cleared.' : 'Removed that building.');
      return;
    }
    // A map piece inside the new building is replaced by it. A building loaded from OpenStreetMap
    // is its own building, like the Calgary Tower standing inside Tower Centre, and stays.
    picked = picked.filter(
      (item) => !sameBuilding(item, building) && (knownBuildings.includes(item) || !coveredBy(building, item)),
    );
    picked.push(building);
    showPicked('Selected that building.');
    if (known === undefined && mayBeRelation(building)) void upgradeSelection(building, ++upgradeToken);
  }

  async function upgradeSelection(placeholder: GeographicBuilding, token: number): Promise<void> {
    const center = ringCentroid(placeholder.parts[0]?.outer ?? []);
    try {
      // The corners of the clicked piece find the building it belongs to. Its touching pieces may
      // be the building next door, so their corners only settle a tie.
      const [clicked, ...touching] = placeholder.parts;
      const corners = clicked?.outer ?? [];
      const nearby = touching.flatMap((part) => part.outer).slice(0, 400);
      const whole = await loadWholeBuilding(
        center.latitude,
        center.longitude,
        { fetch, cache },
        reachFrom(placeholder, center) + 5,
        corners,
        nearby,
      );
        if (token !== upgradeToken || !overlaps(whole, placeholder, center)) return;
      if (!picked.some((item) => sameBuilding(item, placeholder))) return;
      // A map piece can be one pillar of a landmark, so a much larger whole is fine up to the
      // size of a landmark. Beyond that, a click on a house must not pull in a city block.
      if (footprintReach(whole) > Math.max(footprintReach(placeholder) * 6, 400)) return;
      rememberBuilding(whole);
      picked = picked.filter((item) => !sameBuilding(item, placeholder) && !coveredBy(whole, item));
      picked.push(whole);
      showPicked('Selected that building.');
    } catch (error) {
      // The map outline is already selected. A busy lookup must not wipe it, but say why the shape is plain.
      if (token !== upgradeToken || !picked.some((item) => sameBuilding(item, placeholder))) return;
      // Not found just means the map outline is the best there is.
      if (error instanceof GeoFailure && error.kind === 'not-found') return;
      const reason = failureText(error);
      if (reason === '') return;
      const note = `${reason} The map's plain outline is shown, without the roof shape from OpenStreetMap.`;
      address.setMessage(note);
      map.setNote(note);
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

  /** Drop a selection once the map has left it, so a distant outline does not keep the sun and the 3D view busy. */
  function releaseDistantSelection(center: { latitude: number; longitude: number }): void {
    if (picked.length === 0) return;
    const offset = projectToLocal(center, model.origin);
    if (Math.hypot(offset.east, offset.north) < DISTANT_SELECTION_M) return;
    picked = [];
    for (let index = knownBuildings.length - 1; index >= 0; index -= 1) {
      const place = knownBuildings[index]?.parts[0]?.outer[0];
      if (place === undefined) continue;
      const step = projectToLocal(place, center);
      if (Math.hypot(step.east, step.north) > DISTANT_SELECTION_M) knownBuildings.splice(index, 1);
    }
    showPicked('Selection cleared.');
    site = { latitude: center.latitude, longitude: center.longitude, timeZone: timeZoneAt(center.latitude, center.longitude), label: 'Map' };
    describeSite('The sun follows the map.');
    address.setMessage('Selection cleared. The map moved away from those buildings.');
    updateSun();
  }

  function showPicked(note: string, fly = false): void {
    userSelected = true;
    // The dashed outline belongs to an address search, not to whatever is selected now.
    map.setOsmRing([]);
    if (picked.length === 0) {
      placeLabel = null;
      window.clearTimeout(visitTimer);
      refreshPlaces();
      map.setFootprints([]);
      map.setModel(null);
      map.setNote('');
      replaceHouse(new Group());
      address.setClearEnabled(false);
      address.setMessage('Nothing selected. Click a building, or shift-drag a box.');
      return;
    }
    address.setClearEnabled(true);
    picked = picked.map((building) => cityChecked.get(building.id) ?? building);
    void addCityHeights(note);
    model = assembleBuildings(picked);
    site = { ...siteAt(model.origin), label: model.label };
    describeSite(site.timeZone === null ? `${model.label}. ${FIXED_OFFSET_NOTE}` : model.label);
    showHouse(model, { syncMap: true, fly, demo: false, announce: false });
    scheduleVisit();
    const count = picked.length === 1 ? '1 building' : `${picked.length} buildings`;
    const message = `${count}. ${note} Double-click a building here to remove it, or hover it and press Delete.`;
    address.setMessage(message);
    map.setNote(message);
  }

  /**
   * In Calgary, fill in the city's measured heights where OpenStreetMap has none, then redraw.
   * Each building is asked about once; a failed request leaves the OSM estimate in place.
   */
  async function addCityHeights(note: string): Promise<void> {
    const pending = picked.filter((building) => {
      const corner = building.parts[0]?.outer[0];
      return !cityChecked.has(building.id) && corner !== undefined && inCalgary(corner) && lacksHeight(building);
    });
    if (pending.length === 0) return;
    for (const building of pending) cityChecked.set(building.id, building);
    const measured = await Promise.all(pending.map((building) => withCalgaryHeights(building, fetch).catch(() => building)));
    let changed = false;
    measured.forEach((building, index) => {
      if (building === pending[index]) return;
      changed = true;
      cityChecked.set(building.id, building);
      const known = knownBuildings.findIndex((item) => item.id === building.id);
      if (known >= 0) knownBuildings[known] = building;
    });
    if (changed && picked.some((building) => pending.includes(building))) showPicked(note);
  }

  /**
   * In Calgary, draw the city's tree canopy around the model, so trees shade it like buildings do.
   * A larger selection than a block or two would download thousands of crowns, so it gets none.
   */
  async function showTrees(next: HouseModel): Promise<void> {
    const token = ++treeToken;
    cityTrees = [];
    treeOrigin = next.origin;
    selectTree(null);
    const points = next.parts.flatMap((part) => part.footprint);
    if (!inCalgary(next.origin) || points.length === 0) return;
    const east = points.map((point) => point.east);
    const north = points.map((point) => point.north);
    const box = {
      west: Math.min(...east) - TREE_REACH_M,
      east: Math.max(...east) + TREE_REACH_M,
      south: Math.min(...north) - TREE_REACH_M,
      north: Math.max(...north) + TREE_REACH_M,
    };
    if (box.east - box.west > MAX_TREE_AREA_M || box.north - box.south > MAX_TREE_AREA_M) return;
    const southWest = localToLngLat({ east: box.west, north: box.south }, next.origin);
    const northEast = localToLngLat({ east: box.east, north: box.north }, next.origin);
    const area = { south: southWest.latitude, west: southWest.longitude, north: northEast.latitude, east: northEast.longitude };
    let rings: LngLat[][];
    let listed: ListedTree[];
    try {
      // The inventory only names the kind of tree; without it the canopy alone still works.
      [rings, listed] = await Promise.all([loadCalgaryCanopy(area, fetch), loadCalgaryTrees(area, fetch).catch(() => [])]);
    } catch {
      // Trees are extra. Without them the model and its shadow are still right.
      return;
    }
    if (token !== treeToken) return;
    const named = namedTrees(rings, listed, next.origin);
    const avoid = next.parts.map((part) => part.footprint);
    cityTrees = planTrees(named.crowns, named.points, avoid).map((tree) => {
      const at = localToLngLat(tree.at, next.origin);
      return { id: `city:${at.latitude.toFixed(6)},${at.longitude.toFixed(6)}`, at, kind: tree.kind, widthM: tree.widthM };
    });
    drawTrees();
  }

  /** The city's trees with the person's edits, and the trees they planted near the model. */
  function currentTrees(): PlacedTree[] {
    const origin = treeOrigin;
    if (origin === null) return [];
    return treeEdits.apply(cityTrees).filter((tree) => {
      const offset = projectToLocal(tree.at, origin);
      return Math.hypot(offset.east, offset.north) <= MAX_TREE_AREA_M;
    });
  }

  function drawTrees(): void {
    scene.remove(trees);
    disposeObject(trees);
    const origin = treeOrigin;
    const specs =
      origin === null
        ? []
        : currentTrees().map((tree) => ({ ...tree, at: projectToLocal(tree.at, origin) }));
    // Outside Calgary, or before the city's trees arrive, there is nothing to edit.
    treeEditor.setAvailable(origin !== null && (cityTrees.length > 0 || specs.length > 0));
    const ringed = treeEditor.editing() ? selectedTreeId : null;
    trees = createTreeGroup(specs, ringed);
    scene.add(trees);
    map.setTrees(specs, ringed);
    // Grow the shadow to reach the trees around the model.
    const reach = new Box3().setFromObject(house).union(new Box3().setFromObject(trees));
    const size = reach.getSize(new Vector3());
    shadowRadius = Math.max(size.x, size.z, 8) / 2;
    fitSunShadow(sunLight, shadowRadius);
    updateSun();
  }

  function selectTree(id: string | null): void {
    selectedTreeId = id;
    const tree = selectedTree();
    treeEditor.setSelected(tree === undefined ? null : { kind: tree.kind, widthM: tree.widthM, heightM: treeHeightOf(tree) });
    drawTrees();
  }

  function selectedTree(): PlacedTree | undefined {
    return selectedTreeId === null ? undefined : currentTrees().find((item) => item.id === selectedTreeId);
  }

  function editSelectedTree(change: { removed?: boolean; kind?: TreeKind; widthM?: number; heightM?: number }): void {
    const tree = selectedTree();
    if (tree === undefined) return;
    treeEdits.update(tree, change);
    selectTree(change.removed === true ? null : tree.id);
  }

  /** While editing trees, pressing on one starts moving it. Only that tree moves until the drop. */
  function startTreeDrag(treeId: string | null): boolean {
    if (!treeEditor.editing() || treeId === null) return false;
    draggedTree = { id: treeId, to: null };
    return true;
  }

  function dragTree(ground: PlanPoint): void {
    if (draggedTree === null) return;
    draggedTree.to = ground;
    moveTreeMesh(trees, draggedTree.id, ground);
    map.moveTree(draggedTree.id, ground);
  }

  /** Save where the tree was dropped. A press that never moved is a click, which selects it instead. */
  function endTreeDrag(moved: boolean): void {
    const drag = draggedTree;
    draggedTree = null;
    if (!moved || drag === null || drag.to === null || treeOrigin === null) return;
    const tree = currentTrees().find((item) => item.id === drag.id);
    if (tree === undefined) return;
    treeEdits.update(tree, { at: localToLngLat(drag.to, treeOrigin) });
    selectTree(drag.id);
  }

  /** While editing trees, a click picks a tree, or plants one on open ground. */
  function clickTrees(hit: { treeId: string | null; ground: PlanPoint | null }): boolean {
    if (!treeEditor.editing()) return false;
    if (hit.treeId !== null) {
      selectTree(hit.treeId);
    } else if (hit.ground !== null && treeOrigin !== null) {
      const planted = treeEdits.plant(localToLngLat(hit.ground, treeOrigin), 'deciduous', NEW_TREE_WIDTH_M);
      selectTree(planted.id);
    }
    return true;
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

  function selectBox(buildings: PickedFootprint[][]): void {
    picked = uniqueBuildings(buildings.map((parts) => knownBuildingIn(parts) ?? partsToBuilding(parts)));
    showPicked(picked.length === 1 ? 'Selected that building.' : 'Selected the buildings in the box.', true);
  }

  async function selectOpeningBuilding(): Promise<void> {
    address.setBusy(true);
    address.setMessage('Loading Toronto City Hall…');
    await cacheReady;
    try {
      const building = await loadWholeBuilding(DEMO_LOCATION.latitude, DEMO_LOCATION.longitude, { fetch, cache });
      rememberBuilding(building);
      if (userSelected) return;
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
      if (!userSelected) address.setMessage(failureText(error));
    } finally {
      address.setBusy(false);
    }
  }

  async function runSelect(hit: { label: string; latitude: number; longitude: number; osmType: 'node' | 'way' | 'relation'; osmId: number }): Promise<void> {
    userSelected = true;
    address.setBusy(true);
    address.setMessage('Loading the building footprint…');
    map.previewPlace(hit.longitude, hit.latitude);
    try {
      const building = await loadBuilding(hit, { fetch, cache });
      rememberBuilding(building);
      picked = [building];
      model = assembleHouse(building);
      site = { ...siteAt(model.origin), label: hit.label };
      describeSite(site.timeZone === null ? `${hit.label}. ${FIXED_OFFSET_NOTE}` : hit.label);
      map.setOsmRing(building.parts[0]?.outer ?? []);
      showHouse(model, { syncMap: true, fly: true, demo: false });
      placeLabel = shortLabel(hit.label);
      scheduleVisit();
      address.setClearEnabled(true);
      address.setMessage('1 building. Click another to add it, or click this one to remove it.');
    } catch (error) {
      address.setMessage(failureText(error));
    } finally {
      address.setBusy(false);
    }
  }

  /** The current selection as a place to save. */
  async function currentPlace(): Promise<{ label: string; at: LngLat; buildings: GeographicBuilding[] }> {
    const buildings = picked.slice();
    const at = model.origin;
    return { label: placeLabel ?? (await nameSelection(buildings, at)), at, buildings };
  }

  /** A named building keeps its name. A plain house is named by its street address. */
  async function nameSelection(buildings: readonly GeographicBuilding[], at: LngLat): Promise<string> {
    const named = buildings.find((building) => building.label !== 'Building');
    if (buildings.length === 1 && named !== undefined) return named.label;
    const street = await reverseGeocode(at.latitude, at.longitude, { fetch, cache }).catch(() => null);
    const where = street ?? `${at.latitude.toFixed(4)}, ${at.longitude.toFixed(4)}`;
    return buildings.length === 1 ? where : `${where} (${buildings.length} buildings)`;
  }

  function scheduleVisit(): void {
    window.clearTimeout(visitTimer);
    refreshPlaces();
    visitTimer = window.setTimeout(() => {
      void recordVisit();
    }, VISIT_DELAY_MS);
  }

  async function recordVisit(): Promise<void> {
    if (picked.length === 0) return;
    const before = picked;
    const place = await currentPlace();
    // The selection changed during the address lookup. Its own visit is on the way.
    if (picked !== before) return;
    places.visit(place);
    refreshPlaces();
  }

  async function saveHome(): Promise<void> {
    if (picked.length === 0) return;
    const place = await currentPlace();
    const home = places.setHome(place);
    placeLabel = home.label;
    refreshPlaces();
    address.setMessage(`Saved ${home.label} as home. It opens here next time.`);
  }

  async function toggleSaved(): Promise<void> {
    if (picked.length === 0) return;
    const existing = savedHere();
    if (existing !== undefined) {
      places.unsave(existing.id);
      refreshPlaces();
      address.setMessage(`Removed ${existing.label} from saved places.`);
      return;
    }
    const before = picked;
    const place = await currentPlace();
    // The selection changed during the address lookup. Saving the old one would surprise.
    if (picked !== before) return;
    const kept = places.save(place);
    placeLabel = kept.label;
    refreshPlaces();
    address.setMessage(`Saved ${kept.label}. Find it under Places.`);
  }

  /** The saved place the selection is, if it is one. */
  function savedHere(): SavedPlace | undefined {
    if (picked.length === 0) return undefined;
    const here = { at: model.origin, buildings: picked };
    return places.saved().find((place) => samePlace(place, here));
  }

  function refreshPlaces(): void {
    const home = places.home();
    placesPanel.setPlaces(home, places.saved(), places.recent());
    const here = { at: model.origin, buildings: picked };
    const selected = picked.length > 0;
    placesPanel.setSelection({
      selected,
      home: selected && home !== null && samePlace(home, here),
      saved: savedHere() !== undefined,
    });
  }

  /** Select a saved place again. Its buildings are kept, so this needs no lookup unless they were too large to store. */
  function goToPlace(place: SavedPlace): void {
    userSelected = true;
    upgradeToken += 1;
    placeLabel = place.label;
    if (place.buildings !== undefined && place.buildings.length > 0) {
      for (const building of place.buildings) rememberBuilding(building);
      picked = place.buildings.slice();
      showPicked(`Back at ${place.label}.`, true);
      return;
    }
    picked = [];
    // The flight frames the outlines on the map, which are still the place being left.
    map.setFootprints([]);
    map.flyTo(place.at.longitude, place.at.latitude);
    void runPick(place.at);
  }

  const resize = () => {
    resizeRenderer(renderer, camera, canvas);
    map.resize();
  };
  resize();
  window.addEventListener('resize', resize);
  if (startHome === null) openingDone = selectOpeningBuilding();
  else goToPlace(startHome);
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
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  let highlighted: Group | null = null;
  const buildingGroupAt = (event: { clientX: number; clientY: number }): Group | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(house, true);
    for (const hit of hits) {
      let node: Object3D | null = hit.object;
      while (node !== null) {
        const id: unknown = node.userData.buildingId;
        if (typeof id === 'string' && id !== '' && node instanceof Group) return node;
        node = node.parent;
      }
    }
    return null;
  };
  const paintHighlight = (group: Group | null, on: boolean) => {
    group?.traverse((node) => {
      if (!(node instanceof Mesh) || !(node.material instanceof MeshLambertMaterial)) return;
      node.material.emissive.setHex(on ? 0x8a2a2a : 0x000000);
    });
  };
  const highlightBuilding = (group: Group | null) => {
    if (highlighted === group) return;
    paintHighlight(highlighted, false);
    highlighted = group;
    paintHighlight(highlighted, true);
    canvas.style.cursor = group === null ? '' : 'pointer';
  };
  const removeHighlighted = (group: Group | null) => {
    const id: unknown = group?.userData.buildingId;
    if (typeof id !== 'string' || id === '') return;
    const index = picked.findIndex((building) => building.id === id);
    if (index < 0) return;
    highlightBuilding(null);
    picked.splice(index, 1);
    showPicked(picked.length === 0 ? 'Selection cleared.' : 'Removed that building.');
  };
  canvas.addEventListener('pointermove', (event) => {
    if (stage.classList.contains('inset')) {
      highlightBuilding(null);
      return;
    }
    highlightBuilding(buildingGroupAt(event));
  });
  canvas.addEventListener('pointerleave', () => highlightBuilding(null));
  /** The tree under the pointer in 3D, and where the pointer meets the ground. */
  const treeHitAt = (event: { clientX: number; clientY: number }): { treeId: string | null; ground: PlanPoint | null } => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    let treeId: string | null = null;
    for (const hit of raycaster.intersectObject(trees, true)) {
      let node: Object3D | null = hit.object;
      while (node !== null && typeof node.userData.treeId !== 'string') node = node.parent;
      if (node !== null) {
        treeId = node.userData.treeId as string;
        break;
      }
    }
    const ground = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3());
    return { treeId, ground: ground === null ? null : { east: ground.x, north: -ground.z } };
  };
  // A click that was really a drag, to turn the view or move a tree, must not plant a tree.
  let pressedAt: { x: number; y: number } | null = null;
  const pressMoved = (event: { clientX: number; clientY: number }) =>
    pressedAt !== null && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 4;
  canvas.addEventListener('pointerdown', (event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
    if (stage.classList.contains('inset') || event.button !== 0) return;
    if (!startTreeDrag(treeHitAt(event).treeId)) return;
    // The press moves the tree, so the view must not turn with it.
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (draggedTree === null || !pressMoved(event)) return;
    const ground = treeHitAt(event).ground;
    if (ground !== null) dragTree(ground);
  });
  canvas.addEventListener('pointerup', (event) => {
    if (draggedTree === null) return;
    controls.enabled = true;
    endTreeDrag(pressMoved(event));
  });
  canvas.addEventListener('click', (event) => {
    if (stage.classList.contains('inset') || !treeEditor.editing() || pressedAt === null || pressMoved(event)) return;
    clickTrees(treeHitAt(event));
  });
  canvas.addEventListener('dblclick', (event) => {
    if (stage.classList.contains('inset')) return;
    removeHighlighted(buildingGroupAt(event));
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (treeEditor.editing() && selectedTreeId !== null) {
      event.preventDefault();
      editSelectedTree({ removed: true });
      return;
    }
    if (stage.classList.contains('inset') || highlighted === null) return;
    event.preventDefault();
    removeHighlighted(highlighted);
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

/** The first two parts of a geocoder label, such as "123 Main Street, Calgary". */
function shortLabel(label: string): string {
  return label
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, 2)
    .join(', ');
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '−';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function footprintReach(building: GeographicBuilding): number {
  return ringsReach(building.parts.map((part) => part.outer));
}

/** Farthest any corner gets from the first corner: a rough size in metres. */
function ringsReach(rings: readonly (readonly { latitude: number; longitude: number }[])[]): number {
  const origin = rings[0]?.[0];
  if (origin === undefined) return 0;
  let reach = 0;
  for (const ring of rings) {
    for (const point of ring) {
      const local = projectToLocal(point, origin);
      reach = Math.max(reach, Math.hypot(local.east, local.north));
    }
  }
  return reach;
}

function partsToBuilding(parts: PickedFootprint[]): GeographicBuilding {
  const outline = parts[0];
  if (outline === undefined) return footprintToBuilding({ id: 'building/empty', label: 'Building', outer: [], holes: [], heightM: null, baseM: 0 });
  const named = parts.find((part) => part.label !== 'Building');
  return {
    id: outline.id,
    label: named?.label ?? outline.label,
    tags: { building: 'yes' },
    parts: parts.map((part) => ({
      outer: part.outer,
      holes: part.holes,
      tags: tileTags(part),
    })),
    provenance: { source: 'osm', confidence: 0.75, note: 'Building drawn on the map.' },
  };
}

function footprintToBuilding(footprint: PickedFootprint): GeographicBuilding {
  return {
    id: footprint.id,
    label: footprint.label,
    tags: { building: 'yes', ...tileTags(footprint) },
    parts: [{ outer: footprint.outer, holes: footprint.holes }],
    provenance: { source: 'osm', confidence: 0.75, note: 'Building drawn on the map.' },
  };
}

/** OSM-style tags from a map tile outline. One that starts in the air is a building part, flat unless tagged otherwise. */
function tileTags(footprint: PickedFootprint): Record<string, string> {
  return {
    ...(footprint.heightM === null ? {} : { height: String(footprint.heightM) }),
    ...(footprint.baseM > 0 ? { min_height: String(footprint.baseM), 'building:part': 'yes' } : {}),
  };
}

function rememberBuilding(building: GeographicBuilding): void {
  if (knownBuildings.some((item) => item.id === building.id)) return;
  knownBuildings.push(building);
}

/**
 * The lookup found the same building as the map outline. A tower's parts can leave its centre
 * over open ground between the legs, so either one holding the other's centre counts.
 */
function overlaps(whole: GeographicBuilding, placeholder: GeographicBuilding, center: { latitude: number; longitude: number }): boolean {
  if (buildingContains(whole, center.latitude, center.longitude)) return true;
  return whole.parts.some((part) => {
    if (part.outer.length === 0) return false;
    const middle = ringCentroid(part.outer);
    return buildingContains(placeholder, middle.latitude, middle.longitude);
  });
}

/** Farthest corner of the building from a point inside it. */
function reachFrom(building: GeographicBuilding, center: { latitude: number; longitude: number }): number {
  let reach = 0;
  for (const part of building.parts) {
    for (const point of part.outer) {
      const local = projectToLocal(point, center);
      reach = Math.max(reach, Math.hypot(local.east, local.north));
    }
  }
  return reach;
}

function knownBuildingIn(parts: readonly PickedFootprint[]): GeographicBuilding | undefined {
  for (const part of parts) {
    const known = knownBuildings.find((building) => holds(building, part.outer));
    if (known !== undefined) return known;
  }
  return undefined;
}

/**
 * The clicked map piece is part of this building: its centre is inside, and the building is not
 * much smaller than the piece. Tower Centre wraps around the Calgary Tower, so its centre falls
 * inside the tower's footprint, but it is not part of the tower.
 */
function holds(building: GeographicBuilding, piece: readonly { latitude: number; longitude: number }[]): boolean {
  if (piece.length === 0) return false;
  const center = ringCentroid(piece);
  if (!buildingContains(building, center.latitude, center.longitude)) return false;
  return footprintReach(building) >= ringsReach([piece]) * 0.5;
}

/**
 * Only large structures are drawn as building relations. A house-sized outline would spend an
 * OpenStreetMap lookup on every click and find nothing, so it keeps the map outline.
 */
function mayBeRelation(building: GeographicBuilding): boolean {
  return footprintReach(building) > 40;
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

/**
 * Canopy outlines take their kind from a listed tree standing in them. Listed trees outside any
 * outline, usually young ones under the canopy's 2 m floor, are drawn at their own size.
 */
function namedTrees(rings: readonly LngLat[][], listed: readonly ListedTree[], origin: LngLat): { crowns: TreeCrown[]; points: TreePoint[] } {
  const crowns: TreeCrown[] = rings.map((ring) => ({ outline: projectRing(ring, origin) }));
  const points: TreePoint[] = [];
  for (const tree of listed) {
    const at = projectToLocal(tree.at, origin);
    const kind = tree.evergreen ? 'evergreen' : 'deciduous';
    const crown = crowns.find((item) => pointInRing(at, item.outline));
    if (crown === undefined) points.push({ at, kind, widthM: tree.widthM });
    else crown.kind ??= kind;
  }
  return { crowns, points };
}
