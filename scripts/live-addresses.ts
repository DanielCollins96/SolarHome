import { assembleHouse } from '../src/house/assemble.ts';
import { houseFootprintArea } from '../src/house/houseModel.ts';
import { createLookupCache } from '../src/geo/cache.ts';
import { searchAddresses } from '../src/geo/geocode.ts';
import { loadBuilding } from '../src/geo/overpass.ts';

const queries = [
  '10 Downing Street, London',
  '1600 Pennsylvania Avenue NW, Washington, DC',
  '221B Baker Street, London',
  '15 Willow Street, Brooklyn, New York',
  'Chrysler Building, New York',
];

const cache = createLookupCache();
const fetchImpl: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('User-Agent', 'SolarHome/0.1 (local portfolio study)');
  return fetch(input, { ...init, headers });
};

for (const query of queries) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  try {
    const hits = await searchAddresses(query, { fetch: fetchImpl, cache });
    const hit = hits[0];
    if (hit === undefined) {
      console.log(JSON.stringify({ query, error: 'no hit' }));
      continue;
    }
    const building = await loadBuilding(hit, { fetch: fetchImpl, cache });
    const model = assembleHouse(building);
    const part = model.parts[0];
    console.log(
      JSON.stringify({
        query,
        hit: hit.label,
        osm: `${hit.osmType}/${hit.osmId}`,
        label: model.label,
        areaM2: Number(houseFootprintArea(model).toFixed(1)),
        eaveM: part?.eaveHeightM,
        height: model.provenance.eaveHeight,
        roof: part?.roof,
        tags: building.tags,
        issues: model.issues,
      }),
    );
  } catch (error) {
    console.log(JSON.stringify({ query, error: error instanceof Error ? error.message : 'failed' }));
  }
}
