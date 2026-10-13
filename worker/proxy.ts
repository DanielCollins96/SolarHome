interface Env {
  ASSETS: { fetch: (input: Request) => Promise<Response> };
}

const USER_AGENT = 'SolarHome/0.1 (sun-exposure study)';

/**
 * Public Overpass servers, tried in order. overpass-api.de refuses connections from Cloudflare
 * Workers (521), and any one of them can be busy, so a refusal or busy answer moves to the next.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Same-origin stand-in for the Vite dev proxy. Nominatim, Overpass and PVGIS reject anonymous browser calls. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/nominatim')) {
      const target = new URL(`https://nominatim.openstreetmap.org${url.pathname.replace(/^\/api\/nominatim/, '')}${url.search}`);
      return fetch(target, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    }
    if (url.pathname.startsWith('/api/osm/')) {
      // Read-only calls to the main OpenStreetMap API, for single buildings.
      const target = new URL(`https://api.openstreetmap.org/api/0.6${url.pathname.replace(/^\/api\/osm/, '')}${url.search}`);
      return fetch(target, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    }
    if (url.pathname === '/api/pvgis/MRcalc') {
      // Monthly sunlight from the EU's PVGIS. It refuses calls from web pages, so they come through here.
      const target = new URL(`https://re.jrc.ec.europa.eu/api/v5_2/MRcalc${url.search}`);
      return fetch(target, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    }
    if (url.pathname === '/api/overpass') {
      // The body is read once so each server can be sent the same query.
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
      return overpass(request, body);
    }
    return env.ASSETS.fetch(request);
  },
};

async function overpass(request: Request, body: string | undefined): Promise<Response> {
  let last: Response | undefined;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: request.method,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Content-Type': request.headers.get('Content-Type') ?? 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
      });
      // A server that refuses, is busy, or answers with an HTML error page is skipped.
      const json = response.headers.get('Content-Type')?.includes('json') ?? false;
      if (response.ok && json) return response;
      last = response;
    } catch {
      // Unreachable. Try the next server.
    }
  }
  return last ?? new Response('No Overpass server answered.', { status: 504 });
}
