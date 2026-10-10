import type { Feature, FeatureCollection } from 'geojson';
import { Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
import type { GeoJSONSource, MapMouseEvent } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LngLat } from '../geo/projection.ts';
import { splitEdge, snapTracePoint } from '../trace/mapTrace.ts';

// Vite serves the library from a prebundled file, so the worker is not beside that file.
setWorkerUrl(maplibreWorkerUrl);

/** Vector style with an automatic OpenStreetMap / OpenMapTiles attribution. Not satellite imagery. */
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

export interface AreaBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface MapController {
  setTrace(ring: LngLat[]): void;
  setFootprints(rings: LngLat[][]): void;
  setOsmRing(ring: LngLat[]): void;
  setOpacity(opacity: number): void;
  setTracing(tracing: boolean): void;
  flyTo(longitude: number, latitude: number): void;
  previewPlace(longitude: number, latitude: number): void;
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
  },
): MapController {
  const map = new MapLibreMap({
    container,
    style: MAP_STYLE,
    center: [options.longitude, options.latitude],
    zoom: 18,
    boxZoom: false,
  });
  let vertices: LngLat[] = [];
  let footprints: LngLat[][] = [];
  let osmRing: LngLat[] = [];
  let tracing = false;
  let dragging: number | null = null;
  let suppressClick = false;
  let boxStart: { x: number; y: number } | null = null;
  const areaBox = document.createElement('div');
  areaBox.id = 'area-box';
  container.append(areaBox);
  const help = mountMapHelp(container, () => {
    focusOutline(map, footprints.length > 0 ? footprints : [vertices], options.longitude, options.latitude);
  });

  map.on('load', () => {
    map.addSource('osm', { type: 'geojson', data: emptyCollection() });
    map.addSource('trace', { type: 'geojson', data: emptyCollection() });
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
      paint: { 'fill-color': '#e23d3d', 'fill-opacity': 0.5 },
    });
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

  map.on('mousedown', (event: MapMouseEvent) => {
    if (event.originalEvent.shiftKey && !tracing) {
      boxStart = { x: event.point.x, y: event.point.y };
      suppressClick = true;
      map.dragPan.disable();
      placeAreaBox(areaBox, boxStart, boxStart);
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
      placeAreaBox(areaBox, boxStart, { x: event.point.x, y: event.point.y });
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
    areaBox.style.display = 'none';
    map.dragPan.enable();
    if (start === null) return;
    if (Math.hypot(point.x - start.x, point.y - start.y) < 12) return;
    const first = map.unproject([start.x, start.y]);
    const second = map.unproject([point.x, point.y]);
    options.onArea({
      south: Math.min(first.lat, second.lat),
      north: Math.max(first.lat, second.lat),
      west: Math.min(first.lng, second.lng),
      east: Math.max(first.lng, second.lng),
    });
  };
  map.on('mouseup', (event: MapMouseEvent) => {
    if (boxStart !== null) finishBox(event.point);
    endDrag();
  });
  map.on('mouseout', endDrag);
  map.on('click', (event: MapMouseEvent) => {
    if (!tracing) {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      options.onPick(toLngLat(event));
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
  map.on('contextmenu', (event: MapMouseEvent) => {
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
    if (trace && 'setData' in trace) (trace as GeoJSONSource).setData(footprintCollection(footprints, tracing ? vertices : []));
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
      footprints = rings.filter((ring) => ring.length >= 3).map((ring) => ring.map((point) => ({ ...point })));
      vertices = footprints.length === 1 ? (footprints[0]?.map((point) => ({ ...point })) ?? []) : [];
      publish(false);
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
    resize() {
      map.resize();
    },
  };
}

function mountMapHelp(
  container: HTMLElement,
  onShowHouse: () => void,
): { setStatus: (buildingCount: number, cornerCount: number, tracing: boolean) => void } {
  const help = document.createElement('section');
  help.id = 'map-help';
  help.innerHTML = `
    <p id="map-summary"></p>
    <button id="show-house" type="button">Show house</button>
    <details>
      <summary>How to use the map</summary>
      <ul>
        <li>Hold <strong>Shift</strong> and drag a box. The buildings in that box appear in red and in the 3D view.</li>
        <li>Click one building to load only that building.</li>
        <li>Drag to move. Scroll to zoom. <strong>Show house</strong> frames the red outlines.</li>
        <li>Roof, height, and pitch change the 3D model. <strong>Edit outline</strong> changes one red shape.</li>
      </ul>
    </details>
  `;
  container.append(help);
  const summary = help.querySelector<HTMLElement>('#map-summary');
  help.querySelector('#show-house')?.addEventListener('click', (event) => {
    event.stopPropagation();
    onShowHouse();
  });
  return {
    setStatus(buildingCount, cornerCount, tracing) {
      if (summary === null) return;
      if (tracing) {
        summary.textContent = `Editing one outline. ${cornerCount} corners. Click the map to add one.`;
        return;
      }
      if (buildingCount > 1) {
        summary.textContent = `${buildingCount} buildings. Shift-drag to select a different area.`;
        return;
      }
      if (buildingCount === 1) {
        summary.textContent = `1 building, ${cornerCount} corners. Shift-drag to load a whole block.`;
        return;
      }
      summary.textContent = 'Shift-drag a box to load the buildings inside it.';
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

function placeAreaBox(box: HTMLElement, start: { x: number; y: number }, end: { x: number; y: number }): void {
  box.style.display = 'block';
  box.style.left = `${Math.min(start.x, end.x)}px`;
  box.style.top = `${Math.min(start.y, end.y)}px`;
  box.style.width = `${Math.abs(end.x - start.x)}px`;
  box.style.height = `${Math.abs(end.y - start.y)}px`;
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

function footprintCollection(rings: readonly LngLat[][], vertices: readonly LngLat[]): FeatureCollection {
  const features: Feature[] = vertices.map((point, index) => ({
    type: 'Feature',
    properties: { vertex: index },
    geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
  }));
  for (const ring of rings) {
    if (ring.length < 3) continue;
    const closed = [...ring, ring[0]].filter((point): point is LngLat => point !== undefined);
    const coordinates = closed.map((point) => [point.longitude, point.latitude]);
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    });
    features.push({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [coordinates] },
    });
  }
  return { type: 'FeatureCollection', features };
}

