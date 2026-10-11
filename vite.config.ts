import { defineConfig, type ProxyOptions } from 'vitest/config';

const appHeaders = { 'User-Agent': 'SolarHome/0.1 (local portfolio study)' };

/** The browser cannot set User-Agent, and these services refuse anonymous browser calls. */
const proxy: Record<string, ProxyOptions> = {
  '/api/nominatim': {
    target: 'https://nominatim.openstreetmap.org',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
    headers: appHeaders,
  },
  // Single buildings come from the main API. Overpass is only used for box selections.
  '/api/osm': {
    target: 'https://api.openstreetmap.org',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/osm/, '/api/0.6'),
    headers: appHeaders,
  },
  '/api/overpass': {
    target: 'https://overpass-api.de',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api\/overpass$/, '/api/interpreter'),
    headers: appHeaders,
  },
};

export default defineConfig({
  server: { proxy },
  preview: { proxy },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
