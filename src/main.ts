import './style.css';
import { Box3, BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, LineLoop, Mesh, MeshLambertMaterial, Plane, PlaneGeometry, Raycaster, Sprite, Vector2, Vector3, type Material, type Object3D } from 'three';
import { assembleBuildings, assembleHouse, assembleTrace, type GeographicBuilding } from './house/assemble.ts';
import { demoHouseModel } from './house/demoHouse.ts';
import { createHouseObject, partTopHeight } from './house/houseMesh.ts';
import { type HouseModel } from './house/houseModel.ts';
import { createLookupCache, openIndexedDbStore, type KeyValueStore } from './geo/cache.ts';
import { GeoFailure, reverseGeocode, searchAddresses } from './geo/geocode.ts';
import { inCalgary, lacksHeight, loadCalgaryCanopy, loadCalgaryTrees, type ListedTree, withCalgaryHeights } from './geo/calgary.ts';
import { buildingContains, loadBuilding, loadBuildingsInBounds, loadWholeBuilding, mayLackParts } from './geo/overpass.ts';
import { localToLngLat, projectRing, projectToLocal, unprojectRing, type LngLat } from './geo/projection.ts';
import { DEMO_LOCATION } from './scene/demoLocation.ts';
import { createGround, createGroundGrid } from './scene/groundPlane.ts';
import { createNeighbourGroup } from './scene/neighbourMesh.ts';
import { createNorthArrow } from './scene/northArrow.ts';
import { createSavedPlaces, samePlace, type SavedPlace } from './scene/savedPlaces.ts';
import { compareModel, comparePlaceId, lineUp, planBounds } from './scene/compareLayout.ts';
import { createLabelSprite } from './scene/labelSprite.ts';
import { createTreeEdits, MAX_TREE_HEIGHT_M, MAX_TREE_WIDTH_M, MIN_TREE_HEIGHT_M, MIN_TREE_WIDTH_M, type PlacedTree } from './scene/treeEdits.ts';
import { createTreeGroup, moveTreeMesh, planTrees, treeHeightOf, type TreeCrown, type TreeKind, type TreePoint, type TreeSpec } from './scene/treeMesh.ts';
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
  daylightLocalMinutes,
  daylightMinutesAtOffset,
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
import { mountComparePanel } from './ui/comparePanel.ts';
import { mountTreeEditor } from './ui/treeEditor.ts';
import { mountHeatPanel } from './ui/heatPanel.ts';
import { idealNormal, openPlaneYield, skySamples, type SkySamples } from './solar/exposure.ts';
import { createExposureRunner } from './solar/exposureRunner.ts';
import { cellAtUv, cellCorners, cellSamples, roofTotal, collectOccluders, createHeatOverlay, disposeHeatOverlay, summarizeHeat } from './solar/heatmap.ts';
import { mountCellReadout } from './ui/cellReadout.ts';
import { mountContextMenu } from './ui/contextMenu.ts';
import type { ExposureResult } from './solar/exposure.ts';
import type { RoofGrid } from './solar/roofCells.ts';
import { roofGrid } from './solar/roofCells.ts';
import { applyWeather, loadMonthlyWeather, type MonthlyWeather } from './solar/weather.ts';
import { mountCompass, mountSunBadge } from './ui/compass.ts';
import { DEFAULT_CLOCK, mountControls } from './ui/controls.ts';
import { mountMap, type AreaBounds, type PickedFootprint } from './ui/mapView.ts';

const app = document.querySelector<HTMLElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#view');
const mapHost = document.querySelector<HTMLElement>('#map');
const stage = document.querySelector<HTMLElement>('#stage');
if (!app || !canvas || !mapHost || !stage) throw new Error('The page layout is missing.');

const clock = { ...DEFAULT_CLOCK };
/** How long the view takes to swing round when the compass is clicked. */
const COMPASS_TURN_MS = 700;
let faceBearing = (_bearingDeg: number) => {};
const compass = mountCompass(stage, (bearingDeg) => faceBearing(bearingDeg));
const sunBadge = mountSunBadge(stage);
let updateSun = () => {};
let showView = (_view: 'map' | 'plane') => {};
let clearSelection = () => {};
const panel = mountControls(app, clock, {
  onChange: () => updateSun(),
  solarNoonMinutes: (isoDate) => solarNoonMinutes(isoDate),
  onView: (view) => showView(view),
  onClear: () => clearSelection(),
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
/** Old outlines that were looked up again for the parts drawn inside them, by id. */
const partsChecked = new Set<string>();
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

/** Wait this long after the last change to the model, trees or neighbours before tracing the sunlight again. */
const HEAT_DELAY_MS = 600;
/** More roof squares than this is a district, and tracing a year of sun over it would take minutes. */
const MAX_HEAT_CELLS = 60_000;

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

/** The date and place the slider's sunrise and sunset marks were last worked out for. */
let daylightKey = '';

function markDaylight(): void {
  const key = `${clock.date} ${site.latitude} ${site.longitude} ${site.timeZone}`;
  if (key === daylightKey) return;
  daylightKey = key;
  const { sunrise, sunset } =
    site.timeZone !== null
      ? daylightLocalMinutes(clock.date, site.latitude, site.longitude, site.timeZone)
      : daylightMinutesAtOffset(clock.date, site.latitude, site.longitude, longitudeOffsetMinutes(site.longitude));
  panel.setDaylight(sunrise, sunset);
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
    onRightClick: (hit, at) => {
      if (hit.treeId !== null) openTreeMenu(hit.treeId, at);
    },
    onNeighbours: () => scheduleHeat(false),
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
    onClear: () => clearSelection(),
  });
  clearSelection = () => {
    picked = [];
    showPicked('Selection cleared.');
  };
  const setClearEnabled = (enabled: boolean) => {
    address.setClearEnabled(enabled);
    panel.setClearEnabled(enabled);
  };

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
    onCompare: () => enterCompare(),
  });
  refreshPlaces();

  const comparePanel = mountComparePanel(panel.tools, {
    onChoose: (place, chosen) => {
      void choosePlace(place, chosen);
    },
    onDone: () => leaveCompare(true),
  });
  /** Saved places standing side by side in 3D, or null outside compare mode. */
  let comparing: {
    chosen: string[];
    models: Map<string, HouseModel>;
    /** How far each place has been dragged from its spot in the row. */
    moved: Map<string, PlanPoint>;
    /** What was on show before, to go back to: null when nothing was. */
    before: { model: HouseModel; site: Site } | null;
  } | null = null;
  const compareLabels = new Group();
  scene.add(compareLabels);
  /** A compared place being dragged: its mesh, its label, and how far it has gone. */
  let compareDrag: { placeId: string; piece: Group; label: Object3D | null; labelAt: Vector3; from: PlanPoint; by: PlanPoint } | null = null;

  const treeEditor = mountTreeEditor(panel.tools, {
    onToggle: (editing) => {
      map.setNote(editing ? 'Editing trees. Click a tree to resize it, drag it to move it, or click open ground to plant one. Right-click a tree for more.' : '');
      selectTree(null);
    },
    onKind: (kind) => editSelectedTree({ kind }),
    onWidth: (factor) => {
      const tree = selectedTree();
      if (tree === undefined) return;
      editSelectedTree({ widthM: Math.min(MAX_TREE_WIDTH_M, Math.max(MIN_TREE_WIDTH_M, tree.widthM * factor)) });
    },
    onHeight: (stepM) => {
      const tree = selectedTree();
      if (tree === undefined) return;
      // Land on whole and half metres, so a guessed 16.9 m becomes 17.5 m and then 18 m.
      const next = Math.round((treeHeightOf(tree) + stepM) * 2) / 2;
      editSelectedTree({ heightM: Math.min(MAX_TREE_HEIGHT_M, Math.max(MIN_TREE_HEIGHT_M, next)) });
    },
    onRemove: () => editSelectedTree({ removed: true }),
    onReset: () => {
      if (treeOrigin !== null) treeEdits.resetAround(treeOrigin, MAX_TREE_AREA_M);
      selectTree(null);
    },
  });

  const heatPanel = mountHeatPanel(panel.tools, {
    onToggle: (on) => {
      if (on) scheduleHeat(true, 0);
      else clearHeat();
    },
  });
  const heatRunner = createExposureRunner();
  let heatOverlay: Group | null = null;
  let heatTimer = 0;
  let heatToken = 0;
  /** A year of sky for the last place, kept because the sun path only changes with the place. */
  let heatSky: { key: string; sky: SkySamples; clear: SkySamples; idealKwhPerM2: number; weather: MonthlyWeather | null; weatherNote: string } | null = null;
  /** The squares and their sunlight behind the overlay on show, for reading one out on a click. */
  /** `faceCloudLoss` is each roof face's sunlight lost to clouds, null without the weather record. */
  let heatShown: { grid: RoofGrid; result: ExposureResult; idealKwhPerM2: number; faceCloudLoss: number[] | null } | null = null;
  const cellReadout = mountCellReadout(stage);
  /** The clicked square: where its label is pinned, and its outline. */
  let pickedCell: { point: Vector3; outline: LineLoop } | null = null;

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
    markDaylight();
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

  function showHouse(next: HouseModel, options: { syncMap: boolean; fly: boolean; demo: boolean; announce?: boolean; frame?: boolean }): void {
    const built = createHouseObject(next);
    replaceHouse(built.group);
    orbitTarget.copy(houseOrbitTarget(house));
    const box = new Box3().setFromObject(house);
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.y, size.z, 8) / 2;
    viewRadius = radius;
    if (options.frame !== false) frameHouse(camera, controls, box);
    fitSunShadow(sunLight, Math.max(size.x, size.z, 8) / 2, size.y);
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
    scheduleHeat(true);
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
    if (picked.length === 0 || comparing !== null) return;
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
    leaveCompare(false);
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
      scheduleHeat(true);
      setClearEnabled(false);
      address.setMessage('Nothing selected. Click a building, or shift-drag a box.');
      return;
    }
    setClearEnabled(true);
    picked = picked.map((building) => cityChecked.get(building.id) ?? building);
    void addCityHeights(note);
    model = assembleBuildings(picked);
    site = { ...siteAt(model.origin), label: model.label };
    describeSite(site.timeZone === null ? `${model.label}. ${FIXED_OFFSET_NOTE}` : model.label);
    showHouse(model, { syncMap: true, fly, demo: false, announce: false });
    scheduleVisit();
    const count = picked.length === 1 ? '1 building' : `${picked.length} buildings`;
    const message = `${count}. ${note} Click a red building on the map to remove it.`;
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
    // Compared places come from different cities, and no one city's trees stand among them.
    treeOrigin = comparing === null ? next.origin : null;
    selectTree(null);
    if (comparing !== null) {
      drawTrees();
      return;
    }
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

  function showHeat(overlay: Group | null, forMap: Group | null): void {
    // A clicked square belongs to the overlay being replaced.
    unpickCell();
    heatShown = null;
    if (heatOverlay !== null) {
      scene.remove(heatOverlay);
      disposeHeatOverlay(heatOverlay);
    }
    heatOverlay = overlay;
    if (overlay !== null) scene.add(overlay);
    map.setHeat(forMap);
  }

  function clearHeat(): void {
    window.clearTimeout(heatTimer);
    heatToken += 1;
    heatRunner.cancel();
    showHeat(null, null);
  }

  /**
   * Trace the heatmap again after the scene settles. A new model makes the old colours wrong at
   * once, so they go; a tree or a neighbour only changes the shade, so they stay until replaced.
   */
  function scheduleHeat(modelChanged: boolean, delay = HEAT_DELAY_MS): void {
    if (!heatPanel.on()) return;
    if (modelChanged) showHeat(null, null);
    window.clearTimeout(heatTimer);
    heatTimer = window.setTimeout(() => {
      void runHeat();
    }, delay);
  }

  async function runHeat(): Promise<void> {
    const token = ++heatToken;
    const current = model;
    if (house.children.length === 0 || current.parts.length === 0) {
      heatRunner.cancel();
      showHeat(null, null);
      heatPanel.setMessage('Select a building to see the sunlight on its roof.');
      return;
    }
    const grid = roofGrid(current);
    if (grid.cells.length === 0) {
      showHeat(null, null);
      heatPanel.setMessage('This model has no roof facing the sky.');
      return;
    }
    if (grid.cells.length > MAX_HEAT_CELLS) {
      showHeat(null, null);
      heatPanel.setMessage(`That is ${Math.round(grid.cells.length / 1000)},000 m² of roof. Select fewer buildings for a heatmap.`);
      return;
    }
    const { latitude, longitude } = current.origin;
    const year = parseISODate(clock.date).year;
    const key = `${latitude.toFixed(3)},${longitude.toFixed(3)},${year}`;
    if (heatSky?.key !== key) {
      heatPanel.setMessage('Fetching the weather record for this place…');
      const clear = skySamples(latitude, longitude, year);
      let weather: MonthlyWeather | null = null;
      let weatherNote = '';
      try {
        weather = await loadMonthlyWeather(latitude, longitude, { fetch, cache });
      } catch {
        weatherNote = 'The weather record could not be loaded, so this is a cloudless year. ';
      }
      if (token !== heatToken) return;
      const sky = weather === null ? clear : applyWeather(clear, weather);
      heatSky = { key, sky, clear, idealKwhPerM2: openPlaneYield(idealNormal(latitude), sky), weather, weatherNote };
    }
    const { sky, clear, idealKwhPerM2, weather, weatherNote } = heatSky;
    const origin = current.origin;
    const nearTrees: TreeSpec[] =
      treeOrigin === origin ? currentTrees().map((tree) => ({ ...tree, at: projectToLocal(tree.at, origin) })) : [];
    // The map's blocks surround the selection, not compared places standing on open ground.
    const blocks = (comparing !== null ? [] : map.neighbours()).map((block) => ({ ring: projectRing(block.ring, origin), heightM: block.heightM, baseM: block.baseM }));
    const occluders = collectOccluders(current, nearTrees, blocks);
    const { points, normals } = cellSamples(grid);
    heatPanel.setProgress(0);
    let result;
    try {
      result = await heatRunner.run({ points, normals, occluders, sky }, (share) => {
        if (token === heatToken) heatPanel.setProgress(share);
      });
    } catch (error) {
      if (token === heatToken) heatPanel.setMessage(error instanceof Error ? error.message : 'The sunlight calculation stopped.');
      return;
    }
    if (result === null || token !== heatToken || model !== current) return;
    const shares = result.kwhPerM2.map((kwh) => kwh / idealKwhPerM2);
    showHeat(createHeatOverlay(grid, shares), comparing === null ? createHeatOverlay(grid, shares) : null);
    // What clouds take from each face: its open-sky year with the weather record against without.
    const faceCloudLoss =
      weather === null ? null : grid.faces.map((face) => Math.max(0, 1 - openPlaneYield(face.normal, sky) / Math.max(openPlaneYield(face.normal, clear), 1e-6)));
    heatShown = { grid, result, idealKwhPerM2, faceCloudLoss };
    let roofCloudLoss: number | null = null;
    if (faceCloudLoss !== null) {
      let area = 0;
      let lost = 0;
      for (const cell of grid.cells) {
        area += cell.areaM2;
        lost += (faceCloudLoss[cell.face] ?? 0) * cell.areaM2;
      }
      roofCloudLoss = area > 0 ? lost / area : 0;
    }
    const tilt = Math.round(Math.min(Math.abs(latitude), 60));
    const facing = latitude >= 0 ? 'south' : 'north';
    const ideal = `100% is an unshaded panel tilted ${tilt}° facing ${facing}: ${Math.round(idealKwhPerM2).toLocaleString()} kWh/m² a year here.`;
    heatPanel.setSummary(
      summarizeHeat(grid, result, idealKwhPerM2),
      weather === null
        ? `${weatherNote}Each 1 m square shows its sunlight, shade included. ${ideal} Real skies are cloudier, so compare squares rather than sizing a system from this.`
        : `Each 1 m square shows its sunlight in a typical year, after clouds and shade. Clouds come from ${weather.source} weather records for ${weather.firstYear}–${weather.lastYear} (PVGIS © European Union). ${ideal} ` +
            `Panel output is the electricity solar panels would make: 210 W/m² panels, after 20% losses to heat, wiring and the inverter.`,
      roofCloudLoss,
    );
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
    scheduleHeat(false);
    // Grow the shadow to reach the trees around the model.
    const reach = new Box3().setFromObject(house).union(new Box3().setFromObject(trees));
    const size = reach.getSize(new Vector3());
    shadowRadius = Math.max(size.x, size.z, 8) / 2;
    fitSunShadow(sunLight, shadowRadius, size.y);
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

  const contextMenu = mountContextMenu();

  /** A right-click on a tree, in the map or in 3D, offers to copy it or take it away. */
  function openTreeMenu(treeId: string, at: { x: number; y: number }): void {
    contextMenu.open(at, [
      { label: 'Duplicate tree', run: () => duplicateTree(treeId) },
      { label: 'Remove tree', run: () => removeTree(treeId), danger: true },
    ]);
  }

  /**
   * Copy a tree: same kind, width and height, one crown width to the east so the two do not
   * overlap. Tree editing comes on and the copy is selected, ready to drag into place.
   */
  function duplicateTree(treeId: string): void {
    if (treeOrigin === null) return;
    const tree = currentTrees().find((item) => item.id === treeId);
    if (tree === undefined) return;
    const from = projectToLocal(tree.at, treeOrigin);
    const at = localToLngLat({ east: from.east + tree.widthM, north: from.north }, treeOrigin);
    const copy = treeEdits.plant(at, tree.kind, tree.widthM, tree.heightM);
    treeEditor.startEditing();
    selectTree(copy.id);
  }

  function removeTree(treeId: string): void {
    const tree = currentTrees().find((item) => item.id === treeId);
    if (tree === undefined) return;
    treeEdits.update(tree, { removed: true });
    selectTree(selectedTreeId === treeId ? null : selectedTreeId);
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
      setClearEnabled(true);
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
      setClearEnabled(true);
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
      const shown = picked;
      void withParts(place).then((fresh) => {
        if (fresh === null || picked !== shown) return;
        for (const building of fresh) rememberBuilding(building);
        picked = fresh.slice();
        showPicked(`Back at ${place.label}.`);
      });
      return;
    }
    picked = [];
    // The flight frames the outlines on the map, which are still the place being left.
    map.setFootprints([]);
    map.flyTo(place.at.longitude, place.at.latitude);
    void runPick(place.at);
  }

  /**
   * A saved place's buildings, looked up again where they were kept as an outline without the
   * parts drawn inside it, and saved again. Null when nothing needed it.
   */
  async function withParts(place: SavedPlace): Promise<GeographicBuilding[] | null> {
    const stored = place.buildings ?? [];
    const stale = stored.filter((building) => mayLackParts(building) && !partsChecked.has(building.id));
    if (stale.length === 0) return null;
    let changed = false;
    const fresh = await Promise.all(
      stored.map(async (building) => {
        if (!stale.includes(building)) return building;
        partsChecked.add(building.id);
        const corners = building.parts.flatMap((part) => part.outer);
        const center = ringCentroid(building.parts[0]?.outer ?? []);
        try {
          const whole = await loadWholeBuilding(center.latitude, center.longitude, { fetch, cache }, footprintReach(building) + 5, corners.slice(0, 200));
          if (whole.id !== building.id) return building;
          changed = true;
          return whole;
        } catch {
          return building;
        }
      }),
    );
    if (!changed) return null;
    places.updateBuildings(place.id, fresh);
    return fresh;
  }

  /** Stand saved places side by side in 3D, starting with the place on show, if saved, and the next one. */
  function enterCompare(): void {
    const saved = places.saved();
    if (saved.length === 0) return;
    if (comparing === null) {
      comparing = {
        chosen: [],
        models: new Map(),
        moved: new Map(),
        before: house.children.length === 0 ? null : { model, site },
      };
    }
    panel.tools.classList.add('comparing');
    showView('plane');
    const here = savedHere();
    const start = here === undefined ? saved.slice(0, 2) : [here, ...saved.filter((place) => place !== here).slice(0, 1)];
    for (const place of start) void choosePlace(place, true);
    showCompare(true);
  }

  async function choosePlace(place: SavedPlace, chosen: boolean): Promise<void> {
    const state = comparing;
    if (state === null) return;
    state.chosen = state.chosen.filter((id) => id !== place.id);
    if (!chosen) {
      state.moved.delete(place.id);
      showCompare();
      return;
    }
    state.chosen.push(place.id);
    if (state.models.has(place.id)) {
      showCompare(true);
      return;
    }
    comparePanel.show(places.saved(), new Set(state.chosen));
    comparePanel.setMessage(`Loading ${place.label}…`);
    try {
      // A place too large to keep its buildings is looked up again where it was saved.
      const buildings =
        place.buildings !== undefined && place.buildings.length > 0
          ? ((await withParts(place)) ?? place.buildings)
          : [await loadWholeBuilding(place.at.latitude, place.at.longitude, { fetch, cache })];
      state.models.set(place.id, assembleBuildings(buildings));
    } catch (error) {
      if (comparing !== state) return;
      state.chosen = state.chosen.filter((id) => id !== place.id);
      showCompare();
      comparePanel.setMessage(`${place.label} could not be loaded. ${failureText(error)}`);
      return;
    }
    if (comparing === state && state.chosen.includes(place.id)) showCompare(true);
  }

  /** Draw the chosen places in a row, each moved by however far it was dragged. `frame` fits the view to them. */
  function showCompare(frame = false): void {
    const state = comparing;
    if (state === null) return;
    comparePanel.show(places.saved(), new Set(state.chosen));
    clearCompareLabels();
    const names = new Map(places.saved().map((place) => [place.id, place.label]));
    const ready = state.chosen.flatMap((id) => {
      const loaded = state.models.get(id);
      return loaded === undefined ? [] : [{ id, model: loaded }];
    });
    if (ready.length === 0) {
      replaceHouse(new Group());
      scheduleHeat(true);
      comparePanel.setMessage(state.chosen.length > 0 ? 'Loading…' : 'Tick saved places to stand them side by side.');
      return;
    }
    const row = lineUp(ready.map((entry) => entry.model));
    const entries = ready.map((entry, index) => {
      const base = row[index] ?? { east: 0, north: 0 };
      const moved = state.moved.get(entry.id) ?? { east: 0, north: 0 };
      return { placeId: entry.id, model: entry.model, offset: { east: base.east + moved.east, north: base.north + moved.north } };
    });
    const first = names.get(entries[0]?.placeId ?? '') ?? 'the first place';
    model = compareModel(entries, entries.length === 1 ? first : `${entries.length} places`);
    site = { ...siteAt(model.origin), label: first };
    describeSite(`Comparing ${entries.length === 1 ? first : `${entries.length} places`} under the sun at ${first}.`);
    showHouse(model, { syncMap: false, fly: false, demo: false, announce: false, frame });
    for (const entry of entries) {
      const box = planBounds(entry.model);
      const top = Math.max(0, ...entry.model.parts.map(partTopHeight));
      const label = createLabelSprite(names.get(entry.placeId) ?? 'Saved place');
      label.position.set(entry.offset.east + (box.west + box.east) / 2, top + 2, -(entry.offset.north + (box.south + box.north) / 2));
      label.userData.placeId = entry.placeId;
      compareLabels.add(label);
    }
    const loading = state.chosen.length > ready.length;
    comparePanel.setMessage(
      loading ? 'Loading…' : ready.length < 2 ? 'Tick another saved place to stand beside it.' : 'Drag a building to move it. The sun is the first place’s.',
    );
    panel.setStatus(`Comparing ${entries.map((entry) => names.get(entry.placeId) ?? 'a place').join(', ')}.`);
  }

  function clearCompareLabels(): void {
    for (const label of compareLabels.children) {
      if (label instanceof Sprite) label.material.map?.dispose();
    }
    disposeObject(compareLabels);
    compareLabels.clear();
  }

  /** End compare mode. `restore` brings back what was on show before it. */
  function leaveCompare(restore: boolean): void {
    const state = comparing;
    if (state === null) return;
    comparing = null;
    compareDrag = null;
    controls.enabled = true;
    panel.tools.classList.remove('comparing');
    clearCompareLabels();
    comparePanel.show(null, new Set());
    if (!restore) return;
    if (picked.length > 0) {
      showPicked('Back from comparing.');
      return;
    }
    if (state.before === null) {
      replaceHouse(new Group());
      drawTrees();
      scheduleHeat(true);
      updateSun();
      return;
    }
    model = state.before.model;
    site = state.before.site;
    describeSite(site.label);
    showHouse(model, { syncMap: false, fly: false, demo: false, announce: false });
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
    // Compared places stand nowhere on the map.
    if (mapMain) leaveCompare(true);
    if (mapMain) unpickCell();
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
    const placeId = comparePlaceId(id);
    if (placeId !== null) {
      const place = places.saved().find((item) => item.id === placeId);
      highlightBuilding(null);
      if (place !== undefined) void choosePlace(place, false);
      return;
    }
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
  // In compare mode a press on a place drags it along the ground; its shadow follows once it lands.
  canvas.addEventListener('pointerdown', (event) => {
    if (comparing === null || stage.classList.contains('inset') || event.button !== 0) return;
    const piece = buildingGroupAt(event);
    const id: unknown = piece?.userData.buildingId;
    const placeId = typeof id === 'string' ? comparePlaceId(id) : null;
    const from = treeHitAt(event).ground;
    if (piece === null || placeId === null || from === null) return;
    const label = compareLabels.children.find((child) => child.userData.placeId === placeId) ?? null;
    compareDrag = { placeId, piece, label, labelAt: label?.position.clone() ?? new Vector3(), from, by: { east: 0, north: 0 } };
    controls.enabled = false;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (event) => {
    if (compareDrag === null) return;
    const ground = treeHitAt(event).ground;
    if (ground === null) return;
    const by = { east: ground.east - compareDrag.from.east, north: ground.north - compareDrag.from.north };
    compareDrag.by = by;
    compareDrag.piece.position.set(by.east, 0, -by.north);
    compareDrag.label?.position.set(compareDrag.labelAt.x + by.east, compareDrag.labelAt.y, compareDrag.labelAt.z - by.north);
  });
  canvas.addEventListener('pointerup', () => {
    const drag = compareDrag;
    if (drag === null) return;
    compareDrag = null;
    controls.enabled = true;
    canvas.style.cursor = '';
    if (comparing === null || Math.hypot(drag.by.east, drag.by.north) < 0.5) return;
    const moved = comparing.moved.get(drag.placeId) ?? { east: 0, north: 0 };
    comparing.moved.set(drag.placeId, { east: moved.east + drag.by.east, north: moved.north + drag.by.north });
    showCompare();
  });
  canvas.addEventListener('click', (event) => {
    if (stage.classList.contains('inset') || !treeEditor.editing() || pressedAt === null || pressMoved(event)) return;
    clickTrees(treeHitAt(event));
  });
  // Right-drag turns the view, so only a right-click that stays put opens the tree's menu.
  canvas.addEventListener('pointerup', (event) => {
    if (event.button !== 2 || stage.classList.contains('inset') || pressedAt === null || pressMoved(event)) return;
    const treeId = treeHitAt(event).treeId;
    if (treeId !== null) openTreeMenu(treeId, { x: event.clientX, y: event.clientY });
  });
  /** With the heatmap on, a click on a roof square reads out its sunlight. A click elsewhere puts the label away. */
  const pickCell = (event: { clientX: number; clientY: number }): void => {
    unpickCell();
    if (heatOverlay === null || heatShown === null) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    // A wall or a tree in front of the roof hides the square behind it.
    const hit = raycaster.intersectObjects([heatOverlay, house, trees], true)[0];
    const faceIndex: unknown = hit?.object.userData.heatFace;
    if (hit === undefined || typeof faceIndex !== 'number' || hit.uv === undefined) return;
    const { grid, result, idealKwhPerM2 } = heatShown;
    const index = cellAtUv(grid, faceIndex, hit.uv);
    const cell = grid.cells[index];
    const face = grid.faces[faceIndex];
    if (cell === undefined || face === undefined) return;
    const kwh = result.kwhPerM2[index] ?? 0;
    const open = result.openKwhPerM2[index] ?? 0;
    cellReadout.show({
      share: kwh / idealKwhPerM2,
      kwhPerM2: kwh,
      shadeLoss: open > 0 ? Math.max(0, 1 - kwh / open) : 0,
      tiltDeg: face.tiltDeg,
      azimuthDeg: face.azimuthDeg,
      areaM2: cell.areaM2,
      cloudLoss: heatShown.faceCloudLoss === null ? null : (heatShown.faceCloudLoss[faceIndex] ?? 0),
      goodShare: 0.8,
      side: roofTotal(grid, result.kwhPerM2, idealKwhPerM2, { face: faceIndex }),
      roof: grid.faces.filter((other) => other.building === face.building).length > 1 ? roofTotal(grid, result.kwhPerM2, idealKwhPerM2, { building: face.building }) : null,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(cellCorners(grid, index), 3));
    const outline = new LineLoop(geometry, new LineBasicMaterial({ color: 0xffffff }));
    outline.renderOrder = 1;
    scene.add(outline);
    pickedCell = { point: new Vector3(cell.point.x, cell.point.y, cell.point.z), outline };
  };
  canvas.addEventListener('click', (event) => {
    if (stage.classList.contains('inset') || treeEditor.editing() || pressedAt === null || pressMoved(event)) return;
    pickCell(event);
  });
  function unpickCell(): void {
    cellReadout.hide();
    if (pickedCell === null) return;
    scene.remove(pickedCell.outline);
    disposeObject(pickedCell.outline);
    pickedCell = null;
  }
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

  /** A swing of the view round the house, from one compass bearing to another, in radians. */
  let swing: { from: number; to: number; start: number } | null = null;
  faceBearing = (bearingDeg) => {
    const offset = camera.position.clone().sub(controls.target);
    // The camera looks back along its offset, so it faces this bearing, clockwise from north.
    const from = Math.atan2(-offset.x, offset.z);
    let to = (bearingDeg * Math.PI) / 180;
    // The short way round.
    while (to - from > Math.PI) to -= 2 * Math.PI;
    while (to - from < -Math.PI) to += 2 * Math.PI;
    swing = { from, to, start: performance.now() };
  };
  // Grabbing the view takes it back from a swing still under way.
  canvas.addEventListener('pointerdown', () => {
    swing = null;
  });
  canvas.addEventListener('wheel', () => {
    swing = null;
  }, { passive: true });

  const frame = () => {
    if (swing !== null) {
      const t = Math.min(1, (performance.now() - swing.start) / COMPASS_TURN_MS);
      const eased = t * t * (3 - 2 * t);
      const bearing = swing.from + (swing.to - swing.from) * eased;
      const offset = camera.position.clone().sub(controls.target);
      const across = Math.hypot(offset.x, offset.z);
      // Keep the height and the distance; only the side the camera looks from changes.
      camera.position.set(controls.target.x - Math.sin(bearing) * across, camera.position.y, controls.target.z + Math.cos(bearing) * across);
      camera.lookAt(controls.target);
      if (t >= 1) swing = null;
    }
    controls.update();
    if (pickedCell !== null) {
      const screen = pickedCell.point.clone().project(camera);
      cellReadout.place(screen.z > 1 ? null : { x: ((screen.x + 1) / 2) * canvas.clientWidth, y: ((1 - screen.y) / 2) * canvas.clientHeight });
    }
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
  panel.setSite(lede, `${lat}°${site.latitude >= 0 ? 'N' : 'S'}, ${lng}°${site.longitude >= 0 ? 'E' : 'W'} · ${zone}`, site);
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
  // An old outline missing its parts is not reused, so a click on it looks it up afresh.
  if (mayLackParts(building) && !partsChecked.has(building.id)) return;
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
