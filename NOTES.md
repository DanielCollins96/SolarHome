# Notes

Running log of decisions, known issues, and benchmark results. Milestone 1 only.

## Decisions

- **SunCalc 2.1.1**, not the 1.x API. Angles are degrees. Azimuth is clockwise from north (`0` = N, `90` = E, `180` = S, `270` = W). The package ships its own types, so `@types/suncalc` (which describes 1.x radians and a south-based azimuth) is not installed.
- **Scene frame:** X = east, Y = up, Z = south. The unit vector toward the sun is `x = sin(azimuth) cos(altitude)`, `y = sin(altitude)`, `z = -cos(azimuth) cos(altitude)`. A shadow points opposite the horizontal part of that vector, so at solar noon in the northern hemisphere it points north (`z < 0`).
- **Site:** Golden, Colorado, the observer in the NREL Solar Position Algorithm sample (Reda & Andreas, NREL/TP-560-34302). `SunCalc.getPosition` does not take elevation. The published sample uses 1830.14 m; that height is omitted. The unit test still matches the published azimuth and zenith within 0.1°.
- **Clock:** sliders are civil time in `America/Denver`, converted to an absolute instant before calling SunCalc. SunCalc dates are UTC instants.
- **House:** 12 m east-west, 8 m north-south, 3 m eaves, 30° gable, ridge along east-west. The stored footprint is offset by (4 m east, 3 m south) and then centered, so the centering path is actually used. No overhangs. Only an axis-aligned rectangle is accepted; other polygons wait for milestone 2.
- **Orbit:** pan is disabled, and the target is copied back to the house bounding-box center every frame. Neighbour boxes do not move the origin or the target.
- **Shadows:** one directional light follows the sun vector. An ambient fill does not cast shadows; it keeps the shaded side visible. The shadow camera is 48 m across so the hardcoded house and the three nearby boxes all cast. It will be refit to the generated house in milestone 2. Three.js r186 removed `PCFSoftShadowMap`, so the map type is `PCFShadowMap`.
- **North:** a 3D arrow on the ground points toward -Z, and a screen compass rotates so N stays on world north.

## Known issues

- The demonstration house is not a measured building.
- Below the horizon the sun light is switched off. The ambient fill remains, so the scene is not black.
- No benchmark numbers yet. The harness arrives with the exposure pass.

## Benchmarks

None yet.
