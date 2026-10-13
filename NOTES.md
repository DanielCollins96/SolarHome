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

- **Solar heatmap:** each flat roof face is covered with 1 m squares measured along the slope, starting at the eaves. Each square is scored by a year of clear-sky sunlight (one mid-month day per month, every 15 minutes, UTC, so time zones do not matter), as a share of an unshaded panel tilted to the latitude (capped at 60°) facing the equator. Direct light is traced to the sun at every sample; sky light is split the Hay–Davies way: a circumsolar part, in proportion to how clear the sky is (DNI over light above the atmosphere), that falls like the beam and is blocked with it, and an even part seen through 64 cosine-weighted rays per square; ground reflection uses albedo 0.2 and is not shaded. Clear sky is Meinel beam with Kasten–Young air mass and Haurwitz total. Shade comes from the selected buildings, the map's neighbour blocks (map view data, also used in 3D) and the trees. Spruce passes 10% of the light, broadleaf 20% in leaf and 60% bare (November–April north of the equator). Rays run in a Web Worker against a small BVH in `src/solar/rays.ts`. Toronto City Hall, about 15,600 squares, takes about 4 s.
- **Weather:** PVGIS `MRcalc` monthly totals on level ground and their diffuse share (`horirrad=1&d2g=1`), averaged over the record's years. NSRDB first (2005–2015, the Americas), ERA5 where NSRDB answers 400. Each month's cloudless beam and sky light are scaled separately so the month's level-ground totals match; the sun path, and so the shadows, are unchanged. Through `/api/pvgis/MRcalc` on both proxies, since PVGIS refuses browser calls. Cached by 0.02° in IndexedDB. A failed lookup falls back to the cloudless year and says so. Checked against PVGIS `PVcalc` at Calgary (NSRDB, kWh/m²·yr, SolarHome vs PVGIS): flat 1,268 vs 1,268; SE 25° 1,438 vs 1,456; S 51° 1,558 vs 1,580; W 35° 1,182 vs 1,181; N 30° 799 vs 826. Toronto W 25° 1,290 vs 1,294, S 44° 1,508 vs 1,532. An isotropic sky alone read tilted south faces 4–6% low; Hay–Davies brought that to 1–2%. The readout and panel give clouds' share as each face's open-sky year with the record against without.
- **Panel output:** 0.21 kW per m² of panel × performance ratio 0.8, matching PVGIS's estimate with 14% system loss (about 1,160 kWh per kW for a SE 25° roof in Calgary). Shown only with real weather.

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
- Without the weather record the heatmap is a cloudless year, about 25–45% above a real one, and gives no panel output.
- A domed or curved roof is many small faces, so its squares are cut into slivers along the facets.

## Benchmarks

None yet.
