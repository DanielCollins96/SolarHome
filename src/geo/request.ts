/** Call fetch with the window as its receiver. A detached call throws in Chrome. */
export function sendRequest(fetchImpl: typeof fetch, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetchImpl.call(globalThis, input, init);
}
