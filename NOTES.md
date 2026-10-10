# Notes

Running log of decisions, known issues, and benchmark results. Through milestone 2.

## Decisions

- **SunCalc 2.1.1**, not the 1.x API. Angles are degrees. Azimuth is clockwise from north (`0` = N, `90` = E, `180` = S, `270` = W). The package ships its own types, so `@types/suncalc` (which describes 1.x radians and a south-based azimuth) is not installed.
- **Scene frame:** X = east, Y = up, Z = south. The unit vector toward the sun is `x = sin(azimuth) cos(altitude)`, `y = sin(altitude)`, `z = -cos(azimuth) cos(altitude)`. A shadow points opposite the horizontal part of that vector, so at solar noon in the northern hemisphere it points north (`z < 0`).
- **Demonstration site:** Golden, Colorado, the observer in the NREL Solar Position Algorithm sample (Reda & Andreas, NREL/TP-560-34302). `SunCalc.getPosition` does not take elevation. The published sample uses 1830.14 m; that height is omitted. The unit test still matches the published azimuth and zenith within 0.1°.
- **Clock:** the demonstration house uses civil time in `America/Denver`. A searched or imported house uses `round(longitude / 15)` hours from UTC, labeled as having no daylight saving. Browsers cannot turn a lat/lng into an IANA zone, and the stack has no timezone database.
- **Demonstration house:** 12 m east-west, 8 m north-south, 3 m eaves, 30° gable, ridge along east-west. The stored footprint is offset and then centered. The grey neighbour boxes are shown only for that house.
- **Orbit:** pan is disabled, and the target is copied back to the house bounding-box center every frame.
- **Shadows:** one directional light follows the sun vector. An ambient fill does not cast shadows. The shadow camera grows with the house. Three.js r186 removed `PCFSoftShadowMap`, so the map type is `PCFShadowMap`.
- **North:** a 3D arrow on the ground points toward -Z, placed just south of the footprint, and a screen compass rotates so N stays on world north.
- **Projection:** a local tangent plane at the footprint centroid, Earth radius 6,378,137 m. East and north metres match the scene axes, with Z = −north.
- **Lookup:** Nominatim search, then Overpass `out geom` for the way or relation, or buildings within 45 m. The browser calls same-origin `/api/nominatim` and `/api/overpass`. Vite forwards those and sets `User-Agent`, because a page is not allowed to set that header and the services reject anonymous browser calls. `fetch` is invoked with the window as its receiver; Chrome throws "Illegal invocation" if that call is detached. Results are cached in memory and in IndexedDB (`solarhome` / `lookups`). A repeated lookup does not fetch again.
- **Height:** typed value, then LiDAR (no provider yet), OSM `height` (metres or feet, applied as the eave), `building:levels` × 3 m, a shadow estimate (no image yet), otherwise 6 m. OSM `height` sometimes means the ridge, so walls can run a little tall until someone overrides them.
- **Roof:** `flat`, shed (`skillion` / `shed` / `pent` / `lean_to`), gable (`gabled` / `gable` / `gambrel`), hip (`hipped` / `hip` / `pyramidal` / `half-hipped`). `roof:direction` is downhill; a gable or hip ridge is 90° from that. `roof:orientation` along/across is the ridge versus the longest wall. An unknown shape becomes a 25° gable and is reported. Overhang defaults to 0. A hip that cannot be inset is built as a gable.
- **Footprint cleanup:** edges shorter than 0.3 m are dropped, corners within 5° of a right angle are squared, and the ring is forced counter-clockwise. A self-crossing ring is reported and left in place.
- **Mesh:** the gable floor uses the same ridge-split ring as the walls so every edge is shared by two faces. Courtyard holes are walled; they are not cut through a gable or hip roof.
- **Map:** OpenFreeMap Liberty vector tiles. Tracing is off until **Edit outline**, so the map can pan. Satellite tracing waits for a later milestone because of imagery licensing.

## Live lookups

Checked on 2026-10-10. Areas are the cleaned footprint.

| Address | Result | Height | Area |
| --- | --- | --- | --- |
| 10 Downing Street, London | relation 1879842, no height tag | 6 m default, 25° gable | 1137.1 m² |
| 1600 Pennsylvania Avenue NW | White House, 5 levels | 15 m, 25° gable | 1484.3 m² |
| 221B Baker Street, London | nearby 219 Baker Street, 7 levels | 21 m, 25° gable | 1398.9 m² |
| 15 Willow Street, Brooklyn | way 248138042, `height=14.9` | 14.9 m, 25° gable | 99.0 m² |
| Chrysler Building, New York | way 42500770, no height tag | 6 m default, 25° gable | 3649 m² |

The Empire State Building search reached Nominatim, then Overpass answered busy (HTTP 429 or 504) on two tries. The app shows that as a timeout and does not invent a footprint.

In the browser, Willow Street loaded at 99.0 m² and 14.9 m eaves. Choosing it again did not send another Overpass request. Setting the roof to flat marked the roof as a user edit immediately. Three map clicks replaced the outline (21.1 m², source `user-trace`) and kept the eave height. Solar noon at that site on 2026-06-21 was 11:57, with the shadow-north message.

## Known issues

- The demonstration house is not a measured building.
- Below the horizon the sun light is switched off. The ambient fill remains, so the scene is not black.
- Searched houses ignore daylight saving. Summer shadows are about an hour off in regions that observe it.
- OSM `height` is applied as the eave even when the tag means the top of the roof.
- A hip or gable roof does not cut a hole for a courtyard.
- No benchmark numbers yet. The harness arrives with the exposure pass.

## Benchmarks

None yet.
