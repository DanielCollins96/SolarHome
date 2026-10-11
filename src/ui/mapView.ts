import type { Feature, FeatureCollection, GeoJsonProperties, Position } from 'geojson';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature, MapMouseEvent } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { localToLngLat, projectToLocal, type LngLat } from '../geo/projection.ts';
import { distanceToSegment, pointInRing } from '../house/planGeometry.ts';
import { splitEdge, snapTracePoint } from '../trace/mapTrace.ts';
import type { HouseModel } from '../house/houseModel.ts';
import { createModelLayer } from './modelLayer.ts';

// Vite serves the library from a prebundled file, so the worker is not beside that file.
setWorkerUrl(maplibreWorkerUrl);

/** Vector style with an automatic OpenStreetMap / OpenMapTiles attribution. Not satellite imagery. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export interface AreaBounds {
  south: number;
  west: number;
  north: number;
  east: number;
  /** The drawn box, which is usually turned. The bounds above only enclose it. */
  corners: LngLat[];
}

export interface PickedFootprint {
  id: string;
  label: string;
  outer: LngLat[];
  holes: LngLat[][];
  heightM: number | null;
  /** Height of the underside above the ground. Tiles draw a tower's pod as a part starting in the air. */
  baseM: number;
}

export interface MapController {
  setTrace(ring: LngLat[]): void;
  /** `heightM` is the top above the ground; `baseM` lifts a part such as a tower's pod. */
  setFootprints(rings: readonly { ring: readonly LngLat[]; heightM: number | null; baseM?: number }[]): void;
  /** Draw the selection as its 3D model, roofs included. Null goes back to plain footprints. */
  setModel(model: HouseModel | null): void;
  setOsmRing(ring: LngLat[]): void;
  setOpacity(opacity: number): void;
  setTracing(tracing: boolean): void;
  setNote(note: string): void;
  clearSelectionBox(): void;
  flyTo(longitude: number, latitude: number): void;
  previewPlace(longitude: number, latitude: number): void;
  setBearing(degrees: number): void;
  resize(): void;
}

export function mountMap(
  container: HTMLElement,
  options: {
    longitude: number;
    latitude: number;
    onTrace: (ring: LngLat[]) => void;
    onPick: (point: LngLat) => void;
    onArea: (bounds: AreaBounds) => void;
    onBuilding: (parts: PickedFootprint[]) => void;
    /** Each entry is one building: the touching outlines that make it up. */
    onBuildings: (buildings: PickedFootprint[][]) => void;
    /** The person moved the map. Moves the app makes itself, like flying to a result, are not reported. */
    onMove: (center: LngLat) => void;
  },
): MapController {
  const map = new MapLibreMap({
    container,
    style: MAP_STYLE,
    center: [options.longitude, options.latitude],
    zoom: 18,
    pitch: 45,
    boxZoom: false,
  });
  let vertices: LngLat[] = [];
  let footprints: LngLat[][] = [];
  let footprintHeights: number[] = [];
  let footprintBases: number[] = [];
  let osmRing: LngLat[] = [];
  let tracing = false;
  let dragging: number | null = null;
  let suppressClick = false;
  let boxStart: { x: number; y: number } | null = null;
  let boxPath: LngLat[] = [];
  let press: { x: number; y: number; moved: boolean } | null = null;
  const help = mountMapHelp(container);
  const recenter = document.createElement('button');
  recenter.id = 'recenter';
  recenter.type = 'button';
  recenter.title = 'Return to selected area';
  recenter.setAttribute('aria-label', 'Return to selected area');
  recenter.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"></circle>
      <path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
      <circle cx="12" cy="12" r="7.2" fill="none" stroke="currentColor" stroke-width="2"></circle>
    </svg>
  `;
  const returnToSelection = (event: Event) => {
    event.stopPropagation();
    focusOutline(map, footprints.length > 0 ? footprints : [vertices], options.longitude, options.latitude);
  };
  recenter.addEventListener('mousedown', (event) => event.stopPropagation());
  recenter.addEventListener('click', returnToSelection);
  container.append(recenter);

  const basemap = hideBasemapUnderSelection(map, () => footprints, () => Math.max(0, ...footprintHeights));
  const modelLayer = createModelLayer('selection-model');
  let modelShown = false;
  // The flat-topped red blocks stand in for a model only while there is none.
  const showBlocks = () => {
    if (map.getLayer('trace-volume')) map.setLayoutProperty('trace-volume', 'visibility', modelShown ? 'none' : 'visible');
  };
  map.on('load', () => {
    basemap.install();
    map.addSource('osm', { type: 'geojson', data: emptyCollection() });
    map.addSource('select-box', { type: 'geojson', data: emptyCollection() });
    map.addSource('trace', { type: 'geojson', data: emptyCollection() });
    map.addLayer({
      id: 'select-box-fill',
      type: 'fill',
      source: 'select-box',
      paint: { 'fill-color': '#e23d3d', 'fill-opacity': 0.22 },
    });
    map.addLayer({
      id: 'select-box-line',
      type: 'line',
      source: 'select-box',
      paint: { 'line-color': '#e23d3d', 'line-width': 3 },
    });
    map.addLayer({
      id: 'osm-line',
      type: 'line',
      source: 'osm',
      paint: { 'line-color': '#2f6f9f', 'line-width': 2, 'line-dasharray': [1.2, 1] },
    });
    map.addLayer({
      id: 'trace-fill',
      type: 'fill',
      source: 'trace',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#e23d3d', 'fill-opacity': 0.45 },
    });
    map.addLayer({
      id: 'trace-volume',
      type: 'fill-extrusion',
      source: 'trace',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-extrusion-color': '#e23d3d',
        'fill-extrusion-opacity': 0.78,
        'fill-extrusion-height': ['+', ['coalesce', ['get', 'height'], 8], 1.2],
        'fill-extrusion-base': ['coalesce', ['get', 'base'], 0],
      },
    });
    map.addLayer(modelLayer.layer);
    showBlocks();
    map.addLayer({
      id: 'trace-line',
      type: 'line',
      source: 'trace',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#e23d3d', 'line-width': 3 },
    });
    map.addLayer({
      id: 'trace-vertices',
      type: 'circle',
      source: 'trace',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#e23d3d', 'circle-stroke-width': 2 },
    });
    publish(false);
  });

  map.getCanvas().addEventListener('mousedown', (event) => {
    // Ctrl-drag turns the map, so leave it to MapLibre like a right-drag.
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || tracing) return;
    // Stop the pan before it starts, so a click does not grab and drag the map.
    map.dragPan.disable();
    press = { x: event.offsetX, y: event.offsetY, moved: false };
  }, true);
  map.on('mousedown', (event: MapMouseEvent) => {
    if (event.originalEvent.shiftKey && !tracing) {
      press = null;
      boxStart = { x: event.point.x, y: event.point.y };
      boxPath = [toLngLat(event)];
      map.dragPan.disable();
      showGroundShape(map, null, boxPath);
      event.preventDefault();
      return;
    }
    if (!tracing) return;
    const index = vertexUnder(map, event);
    if (index === null) return;
    dragging = index;
    suppressClick = false;
    map.dragPan.disable();
    event.preventDefault();
  });
  map.on('mousemove', (event: MapMouseEvent) => {
    if (boxStart !== null) {
      const place = toLngLat(event);
      rememberDragPoint(boxPath, place);
      const preview = pathWithCurrent(boxPath, place);
      showGroundShape(map, cursorBox(preview), [preview[0] ?? place, place]);
      return;
    }
    if (press !== null) {
      const dx = event.point.x - press.x;
      const dy = event.point.y - press.y;
      if (!press.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        press.moved = true;
      }
      map.panBy([-dx, -dy], { animate: false }, { byUser: true });
      press = { x: event.point.x, y: event.point.y, moved: true };
      return;
    }
    if (dragging === null) return;
    suppressClick = true;
    const current = vertices[dragging];
    const previous = vertices[(dragging - 1 + vertices.length) % vertices.length];
    const before = vertices[(dragging - 2 + vertices.length) % vertices.length];
    vertices[dragging] = snapTracePoint(
      toLngLat(event),
      current ?? toLngLat(event),
      previous,
      before,
      osmRing,
    ).point;
    publish(true);
  });
  const endDrag = () => {
    if (dragging === null) return;
    dragging = null;
    map.dragPan.enable();
  };
  const finishBox = (point: { x: number; y: number }) => {
    const start = boxStart;
    boxStart = null;
    map.dragPan.enable();
    if (start === null) return;
    const projected = map.unproject([point.x, point.y]);
    const place = { longitude: projected.lng, latitude: projected.lat };
    if (Math.hypot(point.x - start.x, point.y - start.y) < 12) {
      hideGroundBox(map);
      return;
    }
    rememberDragPoint(boxPath, place);
    const corners = cursorBox(pathWithCurrent(boxPath, place));
    hideGroundBox(map);
    if (corners === null) {
      help.setNote('Drag out one side, then move sideways. The opposite corner stays on the cursor.');
      swallowFollowingClick();
      return;
    }
    const visible = buildingsInPolygon(map, corners);
    if (visible.length > 40) {
      help.setNote(`Zoom in and drag a smaller box. That area has ${visible.length} buildings.`);
      swallowFollowingClick();
      return;
    }
    if (visible.length > 0) {
      options.onBuildings(visible);
      swallowFollowingClick();
      return;
    }
    help.setNote('Loading buildings…');
    options.onArea({ ...boundsOf(corners), corners });
    swallowFollowingClick();
  };
  let swallowClick = false;
  const swallowFollowingClick = () => {
    swallowClick = true;
    window.setTimeout(() => {
      swallowClick = false;
    }, 0);
  };
  const releasePress = () => {
    const current = press;
    press = null;
    map.dragPan.enable();
    if (current === null || current.moved || tracing) return;
    const parts = buildingUnderCursor(map, { x: current.x, y: current.y });
    if (parts.length === 0) return;
    options.onBuilding(parts);
    swallowFollowingClick();
  };
  map.on('mouseup', (event: MapMouseEvent) => {
    if (boxStart !== null) finishBox(event.point);
    releasePress();
    endDrag();
  });
  window.addEventListener('mouseup', (event) => {
    if (boxStart !== null) {
      const rect = map.getCanvas().getBoundingClientRect();
      finishBox({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    if (press !== null) releasePress();
  });
  map.on('mouseout', endDrag);
  map.on('click', (event: MapMouseEvent) => {
    if (!tracing) {
      if (suppressClick || swallowClick) {
        suppressClick = false;
        swallowClick = false;
      }
      return;
    }
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (vertexUnder(map, event) !== null) return;
    const origin = vertices[0] ?? toLngLat(event);
    const raw = toLngLat(event);
    const split = splitEdge(raw, vertices, origin);
    if (split !== null) {
      vertices.splice(split.index + 1, 0, split.point);
    } else {
      const previous = vertices[vertices.length - 1];
      const before = vertices[vertices.length - 2];
      vertices.push(snapTracePoint(raw, origin, previous, before, osmRing).point);
    }
    publish(true);
  });
  map.on('move', (event: { originalEvent?: Event; byUser?: boolean }) => {
    // Only the person's own moves count. The app's flight to a new search result passes far
    // from it on the way, and must not clear the building it is flying to.
    if (event.originalEvent === undefined && event.byUser !== true) return;
    const center = map.getCenter();
    options.onMove({ longitude: center.lng, latitude: center.lat });
  });
  map.on('contextmenu', (event: MapMouseEvent) => {
    event.preventDefault();
    if (!tracing) return;
    const index = vertexUnder(map, event);
    if (index === null) return;
    event.preventDefault();
    vertices.splice(index, 1);
    publish(true);
  });

  function publish(emit: boolean): void {
    const trace = map.getSource('trace');
    const osm = map.getSource('osm');
    if (tracing) footprints = vertices.length >= 3 ? [vertices.map((point) => ({ ...point }))] : footprints;
    if (trace && 'setData' in trace) {
      (trace as GeoJSONSource).setData(footprintCollection(footprints, tracing ? vertices : [], footprintHeights, footprintBases));
    }
    if (osm && 'setData' in osm) (osm as GeoJSONSource).setData(lineCollection(osmRing));
    if (emit) options.onTrace(vertices.map((point) => ({ ...point })));
    help.setStatus(footprints.length, tracing ? vertices.length : (footprints[0]?.length ?? 0), tracing);
  }

  return {
    setTrace(ring) {
      vertices = ring.map((point) => ({ ...point }));
      footprints = vertices.length >= 3 ? [vertices.map((point) => ({ ...point }))] : [];
      publish(false);
    },
    setFootprints(rings) {
      const kept = rings.filter((entry) => entry.ring.length >= 3);
      footprints = kept.map((entry) => entry.ring.map((point) => ({ ...point })));
      footprintHeights = kept.map((entry) => (entry.heightM !== null && entry.heightM > 0 ? entry.heightM : 8));
      footprintBases = kept.map((entry) => entry.baseM ?? 0);
      vertices = footprints.length === 1 ? (footprints[0]?.map((point) => ({ ...point })) ?? []) : [];
      publish(false);
      basemap.refresh();
    },
    setModel(model) {
      modelShown = model !== null;
      modelLayer.setModel(model);
      showBlocks();
    },
    setOsmRing(ring) {
      osmRing = ring.map((point) => ({ ...point }));
      publish(false);
    },
    setOpacity(opacity) {
      if (!map.getLayer('trace-fill')) return;
      map.setPaintProperty('trace-fill', 'fill-opacity', opacity);
    },
    setTracing(next) {
      tracing = next;
      const first = footprints[0];
      if (next && vertices.length === 0 && first !== undefined) vertices = first.map((point) => ({ ...point }));
      help.setStatus(footprints.length, vertices.length, tracing);
      if (next) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    },
    setNote(note) {
      help.setNote(note);
    },
    clearSelectionBox() {
      hideGroundBox(map);
    },
    flyTo(longitude, latitude) {
      focusOutline(map, footprints.length > 0 ? footprints : [vertices], longitude, latitude);
    },
    previewPlace(longitude, latitude) {
      const show = () => map.flyTo({ center: [longitude, latitude], zoom: 16 });
      if (!map.isStyleLoaded()) {
        map.once('load', show);
        return;
      }
      show();
    },
    setBearing(degrees) {
      map.setBearing(degrees);
    },
    resize() {
      map.resize();
    },
  };
}

const UNDER_SELECTION = 'underSelection';

/**
 * Flatten the basemap's own 3D buildings under the selection. The tiles draw some landmarks
 * blocky, like the Burj Khalifa's outline as a solid 490 m slab, and that gray block would show
 * through and around the selection's shape.
 */
function hideBasemapUnderSelection(
  map: MapLibreMap,
  selected: () => readonly (readonly LngLat[])[],
  tallest: () => number,
): { install: () => void; refresh: () => void } {
  const layers: { id: string; source: string }[] = [];
  type Flattened = { source: string; id: string | number; center: LngLat };
  let hidden = new Map<string, Flattened>();
  let dirty = false;

  /**
   * A flattened building may not answer the next query, and dropping it then would make it pop
   * back up. So each one keeps its centre, and stays flat while that centre is still selected.
   */
  const apply = () => {
    dirty = false;
    const rings = selected();
    const stillSelected = (center: LngLat) => rings.some((ring) => ringContains(ring, center));
    const next = new Map([...hidden].filter(([, target]) => stillSelected(target.center)));
    if (rings.length > 0 && layers.length > 0) {
      for (const { feature, center } of featuresUnder(map, rings, layers.map((layer) => layer.id), tallest())) {
        const source = layers.find((layer) => layer.id === feature.layer.id)?.source;
        if (source === undefined || feature.id === undefined || feature.id === null) continue;
        next.set(`${source}:${feature.id}`, { source, id: feature.id, center });
      }
    }
    for (const [key, target] of hidden) {
      if (next.has(key)) continue;
      map.setFeatureState({ source: target.source, sourceLayer: 'building', id: target.id }, { [UNDER_SELECTION]: false });
    }
    for (const [key, target] of next) {
      if (hidden.has(key)) continue;
      map.setFeatureState({ source: target.source, sourceLayer: 'building', id: target.id }, { [UNDER_SELECTION]: true });
    }
    hidden = next;
  };

  return {
    install() {
      const style = map.getStyle()?.layers ?? [];
      for (const layer of style) {
        if (layer.type !== 'fill-extrusion' || !('source-layer' in layer) || layer['source-layer'] !== 'building') continue;
        if (typeof layer.source !== 'string') continue;
        layers.push({ id: layer.id, source: layer.source });
        // The tiles keep a building's 2D outline next to its 3D parts and mark it `hide_3d`.
        // The style draws it anyway, so a landmark like the Burj Khalifa gets a solid block
        // around its parts. Leave those outlines out of the 3D layer.
        const shown: ExpressionSpecification = ['!', ['to-boolean', ['get', 'hide_3d']]];
        const filter = map.getFilter(layer.id) as ExpressionSpecification | null | undefined;
        map.setFilter(layer.id, filter ? ['all', filter, shown] : shown);
        const flatten = (property: 'fill-extrusion-height' | 'fill-extrusion-base', fallback: ExpressionSpecification) => {
          // The style's own height, a number or an expression such as ['get', 'render_height'].
          const current = (map.getPaintProperty(layer.id, property) ?? fallback) as ExpressionSpecification | number;
          map.setPaintProperty(layer.id, property, ['case', ['boolean', ['feature-state', UNDER_SELECTION], false], 0, current]);
        };
        flatten('fill-extrusion-height', ['get', 'render_height']);
        flatten('fill-extrusion-base', ['get', 'render_min_height']);
      }
      // New tiles arrive as the map moves, so the flattened set is rebuilt once the map settles.
      map.on('moveend', () => {
        dirty = true;
      });
      map.on('sourcedata', (event) => {
        if (layers.some((layer) => layer.source === event.sourceId) && event.isSourceLoaded) dirty = true;
      });
      map.on('idle', () => {
        if (dirty) apply();
      });
      apply();
    },
    refresh() {
      if (layers.length === 0) return;
      apply();
    },
  };
}

/** Basemap buildings that sit inside the selected outlines. A merged block counts only when all of it is inside. */
function featuresUnder(
  map: MapLibreMap,
  rings: readonly (readonly LngLat[])[],
  layers: string[],
  heightM: number,
): { feature: MapGeoJSONFeature; center: LngLat }[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (const point of ring) {
      const screen = map.project([point.longitude, point.latitude]);
      minX = Math.min(minX, screen.x);
      minY = Math.min(minY, screen.y);
      maxX = Math.max(maxX, screen.x);
      maxY = Math.max(maxY, screen.y);
    }
  }
  if (!Number.isFinite(minX)) return [];
  // On a tilted map a raised piece, like a tower's upper stage, is drawn well above its footprint.
  const first = rings[0]?.[0];
  const rise = first === undefined ? 0 : extrusionPixels(map, heightM, first.latitude);
  const features = map.queryRenderedFeatures(
    [
      [minX - 4, minY - 4 - rise],
      [maxX + 4, maxY + 4],
    ],
    { layers },
  );
  const selected = (point: LngLat) => rings.some((ring) => ringContains(ring, point));
  // A concave piece, like a tower leg arching over open ground, has its centre outside itself,
  // so a piece also counts when most of its corners are selected.
  const inside = (outer: LngLat[]) =>
    selected(centroid(outer)) || outer.filter(selected).length * 2 > outer.length;
  const found: { feature: MapGeoJSONFeature; center: LngLat }[] = [];
  for (const feature of features) {
    const polygons =
      feature.geometry.type === 'Polygon'
        ? [feature.geometry.coordinates]
        : feature.geometry.type === 'MultiPolygon'
          ? feature.geometry.coordinates
          : [];
    const outers = polygons.flatMap((polygon) => (polygon[0] === undefined ? [] : [toRing(polygon[0])]));
    const first = outers[0];
    if (first === undefined || !outers.every(inside)) continue;
    // Kept for later passes: a selected corner, so the piece stays flat while it is selected.
    found.push({ feature, center: first.find(selected) ?? centroid(first) });
  }
  return found;
}

function mountMapHelp(container: HTMLElement): {
  setStatus: (buildingCount: number, cornerCount: number, tracing: boolean) => void;
  setNote: (note: string) => void;
} {
  const help = document.createElement('section');
  help.id = 'map-help';
  help.innerHTML = `
    <p id="map-summary"></p>
    <p id="map-note"></p>
    <details>
      <summary>How to use the map</summary>
      <ul>
        <li>Click a gray building to add it. Click a red one to remove it.</li>
        <li>In the 3D view, double-click a building to remove it. Hover one and press Delete to do the same.</li>
        <li>Hold <strong>Shift</strong> and drag. The first direction is one side, and the opposite corner stays on the cursor.</li>
        <li>Left-drag to move. Right-drag to turn. Scroll to zoom. The target button returns to the selected outlines.</li>
      </ul>
    </details>
  `;
  container.append(help);
  const summary = help.querySelector<HTMLElement>('#map-summary');
  const note = help.querySelector<HTMLElement>('#map-note');
  return {
    setStatus(buildingCount, cornerCount, tracing) {
      if (summary === null) return;
      if (tracing) {
        summary.textContent = `Editing one outline. ${cornerCount} corners. Click the map to add one.`;
        return;
      }
      if (buildingCount > 1) {
        summary.textContent = `${buildingCount} buildings. Click a red one to remove it, or click another to add it.`;
        return;
      }
      if (buildingCount === 1) {
        summary.textContent = `1 building. Click another to add it, or click this one to remove it.`;
        return;
      }
      summary.textContent = 'Click buildings to select them. Shift-drag; the opposite corner stays on the cursor.';
    },
    setNote(text) {
      if (note !== null) note.textContent = text;
      if (text !== '' && summary !== null) summary.textContent = '';
    },
  };
}

function focusOutline(map: MapLibreMap, rings: readonly (readonly LngLat[])[], longitude: number, latitude: number): void {
  if (!map.isStyleLoaded()) {
    map.once('load', () => focusOutline(map, rings, longitude, latitude));
    return;
  }
  const points = rings.flat();
  if (points.length < 2) {
    map.flyTo({ center: [longitude, latitude], zoom: 18 });
    return;
  }
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const point of points) {
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
  }
  if (east - west < 1e-7 && north - south < 1e-7) {
    map.flyTo({ center: [west, south], zoom: 18 });
    return;
  }
  const canvas = map.getCanvas();
  const height = Math.max(canvas.clientHeight, 1);
  const width = Math.max(canvas.clientWidth, 1);
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      padding: {
        top: Math.min(72, Math.floor(height * 0.16)),
        bottom: Math.min(24, Math.floor(height * 0.08)),
        left: Math.min(20, Math.floor(width * 0.06)),
        right: Math.min(20, Math.floor(width * 0.06)),
      },
      maxZoom: 19,
    },
  );
}

function buildingsInPolygon(map: MapLibreMap, corners: readonly LngLat[]): PickedFootprint[][] {
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  // A tall tower is drawn above its footprint, so a box around the base
  // does not cover the shaft's pixels. Take every rendered building and
  // keep the ones whose footprint sits inside the ground polygon.
  // Filter before merging duplicates: the whole screen can hold thousands of outlines.
  const inside = queryBuildings(map, [[0, 0], [width, height]])
    .flatMap(featureFootprints)
    .filter((building) => ringContains(corners, shapeOf(building).center));
  return groupStructures(footprintsFrom(inside));
}

/** One side follows the first part of the drag. The opposite corner is the cursor. */
function cursorBox(path: readonly LngLat[]): LngLat[] | null {
  const origin = path[0];
  const currentLng = path[path.length - 1];
  if (origin === undefined || currentLng === undefined) return null;
  const current = projectToLocal(currentLng, origin);
  let axis: { east: number; north: number } | null = null;
  for (const point of path) {
    const local = projectToLocal(point, origin);
    const length = Math.hypot(local.east, local.north);
    if (length < 12) continue;
    axis = { east: local.east / length, north: local.north / length };
    break;
  }
  if (axis === null) return null;
  const along = current.east * axis.east + current.north * axis.north;
  const across = current.east * -axis.north + current.north * axis.east;
  if (Math.abs(across) < 2) return null;
  return [
    { east: 0, north: 0 },
    { east: axis.east * along, north: axis.north * along },
    { east: current.east, north: current.north },
    { east: -axis.north * across, north: axis.east * across },
  ].map((point) => localToLngLat(point, origin));
}

function showGroundShape(map: MapLibreMap, corners: readonly LngLat[] | null, axis: readonly LngLat[]): void {
  const source = map.getSource('select-box');
  if (source === undefined || !('setData' in source)) return;
  if (corners !== null && corners.length >= 4) {
    const ring = [...corners, corners[0]].filter((point): point is LngLat => point !== undefined);
    (source as GeoJSONSource).setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [ring.map((point) => [point.longitude, point.latitude])] },
    });
    return;
  }
  const line = axis.filter((point): point is LngLat => point !== undefined);
  if (line.length < 2) {
    (source as GeoJSONSource).setData(emptyCollection());
    return;
  }
  (source as GeoJSONSource).setData({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: line.map((point) => [point.longitude, point.latitude]) },
  });
}

function hideGroundBox(map: MapLibreMap): void {
  const source = map.getSource('select-box');
  if (source !== undefined && 'setData' in source) (source as GeoJSONSource).setData(emptyCollection());
}

function rememberDragPoint(path: LngLat[], point: LngLat): void {
  const last = path[path.length - 1];
  if (last === undefined) {
    path.push(point);
    return;
  }
  const step = projectToLocal(point, last);
  if (Math.hypot(step.east, step.north) >= 3) path.push(point);
}

function pathWithCurrent(path: readonly LngLat[], point: LngLat): LngLat[] {
  const last = path[path.length - 1];
  if (last === undefined) return [point];
  if (last.longitude === point.longitude && last.latitude === point.latitude) return [...path];
  return [...path, point];
}

function boundsOf(corners: readonly LngLat[]): { south: number; west: number; north: number; east: number } {
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const corner of corners) {
    south = Math.min(south, corner.latitude);
    north = Math.max(north, corner.latitude);
    west = Math.min(west, corner.longitude);
    east = Math.max(east, corner.longitude);
  }
  return { south, west, north, east };
}

/** The piece under the cursor, plus the other pieces of the same structure that touch it. */
function buildingUnderCursor(map: MapLibreMap, point: { x: number; y: number }): PickedFootprint[] {
  // One tile feature can hold every house on the block, so pick the outline under the cursor, not the feature's first.
  const direct = footprintsFrom(queryBuildings(map, [point.x, point.y]));
  const ground = map.unproject([point.x, point.y]);
  const cursor = { longitude: ground.lng, latitude: ground.lat };
  const clicked =
    direct.find((building) => ringContains(building.outer, cursor)) ??
    shaftUnder(map, point, direct) ??
    buildingUnderShaft(map, point);
  if (clicked === undefined) return [];
  return partsOfSameStructure(map, clicked);
}

function partsOfSameStructure(map: MapLibreMap, seed: PickedFootprint): PickedFootprint[] {
  const origin = shapeOf(seed).center;
  const pad = 100 / metersPerPixel(map, origin.latitude);
  const bounds = footprintBounds(map, seed.outer);
  const nearby = footprintsFrom(queryBuildings(map, [
    [bounds.minX - pad, bounds.minY - pad],
    [bounds.maxX + pad, bounds.maxY + pad],
  ]));
  return growStructure(seed, nearby.filter((item) => !sameFootprint(item, seed)));
}

/** The seed plus every piece in the pool that reaches it through touching pieces. Taken pieces leave the pool. */
function growStructure(seed: PickedFootprint, pool: PickedFootprint[]): PickedFootprint[] {
  const group = [seed];
  for (let next = 0; next < group.length && group.length < 40; next += 1) {
    const member = group[next];
    if (member === undefined) break;
    for (let index = pool.length - 1; index >= 0; index -= 1) {
      const candidate = pool[index];
      if (candidate === undefined || !sameStructure(member, candidate)) continue;
      group.push(candidate);
      pool.splice(index, 1);
    }
  }
  return group;
}

/** Split loose outlines into buildings, so a box selects a house and its attached garage as one, like a click. */
function groupStructures(footprints: readonly PickedFootprint[]): PickedFootprint[][] {
  const pool = [...footprints];
  const groups: PickedFootprint[][] = [];
  while (pool.length > 0) {
    const seed = pool.pop();
    if (seed !== undefined) groups.push(growStructure(seed, pool));
  }
  return groups;
}

interface Shape {
  center: LngLat;
  area: number;
  west: number;
  south: number;
  east: number;
  north: number;
}

const shapes = new WeakMap<PickedFootprint, Shape>();

/** Centroid, area and bounds, measured once per outline. Grouping compares every pair. */
function shapeOf(footprint: PickedFootprint): Shape {
  const known = shapes.get(footprint);
  if (known !== undefined) return known;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const point of footprint.outer) {
    west = Math.min(west, point.longitude);
    east = Math.max(east, point.longitude);
    south = Math.min(south, point.latitude);
    north = Math.max(north, point.latitude);
  }
  const shape = { center: centroid(footprint.outer), area: ringAreaAbs(footprint.outer), west, south, east, north };
  shapes.set(footprint, shape);
  return shape;
}

/** Pieces of one tower touch, or one sits on the other. A block-sized outline does not. */
function sameStructure(a: PickedFootprint, b: PickedFootprint): boolean {
  const shapeA = shapeOf(a);
  const shapeB = shapeOf(b);
  // About a metre of slack. Outlines whose bounds do not meet can neither touch nor contain each other.
  const slack = 0.00001;
  const slackLng = slack / Math.max(Math.cos((shapeA.center.latitude * Math.PI) / 180), 0.01);
  if (
    shapeA.east + slackLng < shapeB.west || shapeB.east + slackLng < shapeA.west ||
    shapeA.north + slack < shapeB.south || shapeB.north + slack < shapeA.south
  ) {
    return false;
  }
  const smaller = Math.min(shapeA.area, shapeB.area);
  const larger = Math.max(shapeA.area, shapeB.area);
  if (larger > Math.max(smaller * 12, 12_000)) return false;
  if (ringContains(a.outer, shapeB.center) || ringContains(b.outer, shapeA.center)) return true;
  // Touching only. Houses a side yard apart are separate buildings, and tiles cut one house into touching pieces.
  return ringsWithin(a.outer, b.outer, 1);
}

function ringsWithin(a: readonly LngLat[], b: readonly LngLat[], meters: number): boolean {
  const origin = a[0];
  if (origin === undefined) return false;
  const left = a.map((point) => projectToLocal(point, origin));
  const right = b.map((point) => projectToLocal(point, origin));
  for (const point of left) {
    if (distanceToRing(point, right) <= meters) return true;
  }
  for (const point of right) {
    if (distanceToRing(point, left) <= meters) return true;
  }
  return false;
}

function distanceToRing(point: { east: number; north: number }, ring: readonly { east: number; north: number }[]): number {
  let best = Infinity;
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    if (start === undefined || end === undefined) continue;
    best = Math.min(best, distanceToSegment(point, start, end));
  }
  return best;
}

function metersPerPixel(map: MapLibreMap, latitude: number): number {
  return (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** map.getZoom();
}

/** A pitched tower is drawn above its footprint, so a click on the shaft misses the ground polygon. */
function buildingUnderShaft(map: MapLibreMap, point: { x: number; y: number }): PickedFootprint | undefined {
  const reach = shaftReachPixels(map);
  if (reach < 12) return undefined;
  const below = footprintsFrom(queryBuildings(map, [
    [point.x - 28, point.y],
    [point.x + 28, point.y + reach],
  ]));
  return shaftUnder(map, point, below);
}

/** The outline whose walls rise through the cursor: the nearest one below it on screen. */
function shaftUnder(map: MapLibreMap, point: { x: number; y: number }, below: readonly PickedFootprint[]): PickedFootprint | undefined {
  let best: { building: PickedFootprint; above: number } | undefined;
  for (const building of below) {
    const bounds = footprintBounds(map, building.outer);
    if (point.x < bounds.minX - 4 || point.x > bounds.maxX + 4) continue;
    const above = bounds.minY - point.y;
    if (above < -8) continue;
    const limit = extrusionPixels(map, building.heightM ?? 8, centroid(building.outer).latitude);
    if (above > limit + 16) continue;
    if (best === undefined || above < best.above) best = { building, above };
  }
  return best?.building;
}

function shaftReachPixels(map: MapLibreMap): number {
  const center = map.getCenter();
  return Math.min(520, extrusionPixels(map, 360, center.lat));
}

function extrusionPixels(map: MapLibreMap, heightM: number, latitude: number): number {
  const metersPerPixel = (156543.03392 * Math.cos((latitude * Math.PI) / 180)) / 2 ** map.getZoom();
  const pitch = (map.getPitch() * Math.PI) / 180;
  if (metersPerPixel <= 0) return 0;
  return (heightM / metersPerPixel) * Math.sin(pitch);
}

function footprintBounds(map: MapLibreMap, ring: readonly LngLat[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const vertex of ring) {
    const screen = map.project([vertex.longitude, vertex.latitude]);
    minX = Math.min(minX, screen.x);
    minY = Math.min(minY, screen.y);
    maxX = Math.max(maxX, screen.x);
    maxY = Math.max(maxY, screen.y);
  }
  return { minX, minY, maxX, maxY };
}

function centroid(ring: readonly LngLat[]): LngLat {
  const latitude = ring.reduce((sum, vertex) => sum + vertex.latitude, 0) / ring.length;
  const longitude = ring.reduce((sum, vertex) => sum + vertex.longitude, 0) / ring.length;
  return { latitude, longitude };
}

function ringContains(ring: readonly LngLat[], point: LngLat): boolean {
  return pointInRing(
    { east: 0, north: 0 },
    ring.map((vertex) => projectToLocal(vertex, point)),
  );
}

function ringAreaAbs(ring: readonly LngLat[]): number {
  const origin = ring[0];
  if (origin === undefined) return 0;
  const local = ring.map((vertex) => projectToLocal(vertex, origin));
  let twice = 0;
  for (let index = 0; index < local.length; index += 1) {
    const current = local[index];
    const next = local[(index + 1) % local.length];
    if (current === undefined || next === undefined) continue;
    twice += current.east * next.north - next.east * current.north;
  }
  return Math.abs(twice / 2);
}

function queryBuildings(map: MapLibreMap, geometry: [number, number] | [[number, number], [number, number]]): MapGeoJSONFeature[] {
  if (!map.getStyle()) return [];
  // isStyleLoaded() is false while the selection box is still updating, and that
  // is exactly when a shift-drag needs the buildings that are already on screen.
  const layers = buildingLayerIds(map);
  const queried = layers.length > 0 ? map.queryRenderedFeatures(geometry, { layers }) : map.queryRenderedFeatures(geometry);
  return queried.filter((feature) => layers.length > 0 || feature.sourceLayer === 'building');
}

function buildingLayerIds(map: MapLibreMap): string[] {
  const layers = map.getStyle()?.layers ?? [];
  const ids: string[] = [];
  for (const layer of layers) {
    if ('source-layer' in layer && layer['source-layer'] === 'building') ids.push(layer.id);
  }
  return ids;
}

/** Merge the copies of one outline: the flat and 3D layers, and neighbouring tiles, each return it. */
function footprintsFrom(source: readonly MapGeoJSONFeature[] | readonly PickedFootprint[]): PickedFootprint[] {
  const all = source.flatMap((item) => ('outer' in item ? [item] : featureFootprints(item)));
  const picks: PickedFootprint[] = [];
  for (const pick of all) {
    const existing = picks.find((item) => sameFootprint(item, pick));
    if (existing !== undefined) {
      if (pick.outer.length > existing.outer.length) {
        existing.outer = pick.outer;
        existing.holes = pick.holes;
        existing.heightM = pick.heightM ?? existing.heightM;
        shapes.delete(existing);
      }
      continue;
    }
    picks.push(pick);
  }
  return picks;
}

function featureFootprints(feature: MapGeoJSONFeature): PickedFootprint[] {
  const id = feature.id !== undefined && feature.id !== null ? `way/${feature.id}` : '';
  const label = readLabel(feature.properties);
  const heightM = readHeight(feature.properties);
  const baseM = readBase(feature.properties);
  if (feature.geometry.type === 'Polygon') {
    const pick = footprintFromRings(id, label, feature.geometry.coordinates.map(toRing), heightM, baseM);
    return pick === null ? [] : [pick];
  }
  if (feature.geometry.type === 'MultiPolygon') {
    // The tiles merge whole blocks into one feature, so its id names no single building.
    return feature.geometry.coordinates.flatMap((polygon) => {
      const rings = polygon.map(toRing);
      const pick = footprintFromRings('', label, rings, heightM, baseM);
      return pick === null ? [] : [pick];
    });
  }
  return [];
}

function footprintFromRings(
  id: string,
  label: string,
  rings: LngLat[][],
  heightM: number | null,
  baseM: number,
): PickedFootprint | null {
  const outer = rings[0];
  if (outer === undefined || outer.length < 3) return null;
  const holes = rings.slice(1).filter((ring) => ring.length >= 3 && ringContains(outer, centroid(ring)));
  return { id: id === '' ? ringId(outer) : id, label, outer, holes, heightM, baseM };
}

function sameFootprint(a: PickedFootprint, b: PickedFootprint): boolean {
  // Outlines without a usable id are named by their first corner, which each tile cuts differently.
  // A matching size stands in for the id, so a tower on its podium is not merged into it.
  if (a.id !== b.id && !(a.id.startsWith('ring:') && b.id.startsWith('ring:') && similarArea(a, b))) return false;
  const left = shapeOf(a).center;
  const right = shapeOf(b).center;
  return Math.abs(left.latitude - right.latitude) < 0.00004 && Math.abs(left.longitude - right.longitude) < 0.00006;
}

function similarArea(a: PickedFootprint, b: PickedFootprint): boolean {
  const left = shapeOf(a).area;
  const right = shapeOf(b).area;
  return Math.min(left, right) >= Math.max(left, right) * 0.85;
}

function toRing(coordinates: Position[]): LngLat[] {
  const ring = coordinates.map((position) => ({ longitude: position[0] ?? 0, latitude: position[1] ?? 0 }));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first !== undefined && last !== undefined && Math.abs(first.longitude - last.longitude) < 1e-7 && Math.abs(first.latitude - last.latitude) < 1e-7) {
    ring.pop();
  }
  return ring;
}

function ringId(ring: readonly LngLat[]): string {
  const first = ring[0];
  // No slashes: other code compares the last path segment of an id.
  return `ring:${first?.longitude.toFixed(6) ?? 0}:${first?.latitude.toFixed(6) ?? 0}:${ring.length}`;
}

function readLabel(properties: GeoJsonProperties): string {
  const name = properties?.name;
  return typeof name === 'string' && name !== '' ? name : 'Building';
}

function readHeight(properties: GeoJsonProperties): number | null {
  const raw = properties?.render_height ?? properties?.height;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readBase(properties: GeoJsonProperties): number {
  const raw = properties?.render_min_height ?? properties?.min_height;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function vertexUnder(map: MapLibreMap, event: MapMouseEvent): number | null {
  if (!map.getLayer('trace-vertices')) return null;
  const hits = map.queryRenderedFeatures(event.point, { layers: ['trace-vertices'] });
  const properties = hits[0]?.properties;
  if (properties === null || properties === undefined) return null;
  const value: unknown = properties.vertex;
  const index = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(index) ? index : null;
}

function toLngLat(event: MapMouseEvent): LngLat {
  return { longitude: event.lngLat.lng, latitude: event.lngLat.lat };
}

function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function lineCollection(ring: LngLat[]): FeatureCollection {
  if (ring.length < 2) return emptyCollection();
  const closed = [...ring, ring[0]].filter((point): point is LngLat => point !== undefined);
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: closed.map((point) => [point.longitude, point.latitude]) },
      },
    ],
  };
}

function footprintCollection(
  rings: readonly LngLat[][],
  vertices: readonly LngLat[],
  heights: readonly number[],
  bases: readonly number[],
): FeatureCollection {
  const features: Feature[] = vertices.map((point, index) => ({
    type: 'Feature',
    properties: { vertex: index },
    geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
  }));
  rings.forEach((ring, index) => {
    if (ring.length < 3) return;
    const closed = [...ring, ring[0]].filter((point): point is LngLat => point !== undefined);
    const coordinates = closed.map((point) => [point.longitude, point.latitude]);
    const height = heights[index] ?? 8;
    const base = bases[index] ?? 0;
    features.push({
      type: 'Feature',
      properties: { height, base },
      geometry: { type: 'LineString', coordinates },
    });
    features.push({
      type: 'Feature',
      properties: { height, base },
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    });
  });
  return { type: 'FeatureCollection', features };
}

