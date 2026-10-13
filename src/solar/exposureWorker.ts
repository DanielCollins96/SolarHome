import { computeExposure, type ExposureInput } from './exposure.ts';

/** Traces the year's sunlight off the main thread, so the map keeps moving while it runs. */
self.onmessage = (event: MessageEvent<ExposureInput>) => {
  const result = computeExposure(event.data, (done, total) => {
    self.postMessage({ type: 'progress', done, total });
  });
  self.postMessage({ type: 'done', result }, { transfer: [result.kwhPerM2.buffer, result.openKwhPerM2.buffer] });
};
