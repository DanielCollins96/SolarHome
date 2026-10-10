# SolarHome

Browser tool for a centered 3D house and its sun. This repository is at **milestone 1**: a hardcoded house, live shadows, and a sun-direction test. Later milestones (address lookup, tracing, annual exposure, what-if structures) are not started.

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually http://localhost:5173). Drag to orbit, scroll to zoom, and move the date or time slider. **Jump to solar noon** puts the sun due south at Golden, Colorado, so the shadow falls north.

```bash
npm test
npm run build
```

## Scene

The house footprint centroid is the origin, the ground is y = 0, and the orbit target is the house bounding-box center. Axes are **X = east, Y = up, Z = south**. The site is fixed at Golden, Colorado (39.742476°N, 105.1786°W) until address search exists. Clock times are America/Denver.

The house and the grey boxes are placeholders. Height and roof shape are not measured.
