# SolarHome

Browser tool for a real house outline, a centered 3D model, and live sun shadows. This repository is at **milestone 2**: address search, OpenStreetMap footprints, roof presets, and map tracing. A **Solar heatmap** scores each 1 m roof square by a clear-sky year of sun, with shade from the building, its neighbours and trees. Screenshot tracing is not started.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints. Search an address, pick a result, and the house rebuilds from the OpenStreetMap footprint. **Edit outline** lets you click corners, drag them, click an edge to split it, and right-click a corner to delete it. Roof type, pitch, eave height, and plan rotation update the 3D model when you leave the field. **Jump to solar noon** puts the sun due south.

```bash
npm test
npm run build
```

`scripts/live-addresses.ts` repeats five live lookups. It is not part of `npm test`.

```bash
node --experimental-strip-types scripts/live-addresses.ts
```

## Scene

The house footprint centroid is the origin, the ground is y = 0, and the orbit target is the house bounding-box center. Axes are **X = east, Y = up, Z = south**. The demonstration house stays at Golden, Colorado, in America/Denver. A searched or imported house uses a fixed offset from longitude, without daylight saving.

Map data is © OpenStreetMap contributors, drawn with the OpenFreeMap vector style. Satellite imagery is not included.
