/** Absolute URL on this page's origin. Tests have no window, so they use localhost. */
export function sameOrigin(path: string): URL {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(path, origin);
}
