import type { ExposureInput, ExposureResult } from './exposure.ts';

/**
 * One exposure job at a time in a Web Worker. Starting a new job, or cancelling, stops the
 * old one at once: the worker is replaced rather than asked to finish.
 */
export function createExposureRunner(): {
  run: (input: ExposureInput, onProgress: (share: number) => void) => Promise<ExposureResult | null>;
  cancel: () => void;
} {
  let worker: Worker | null = null;
  let settle: ((result: ExposureResult | null) => void) | null = null;

  const cancel = () => {
    worker?.terminate();
    worker = null;
    settle?.(null);
    settle = null;
  };

  return {
    cancel,
    run(input, onProgress) {
      cancel();
      const job = new Worker(new URL('./exposureWorker.ts', import.meta.url), { type: 'module' });
      worker = job;
      return new Promise((resolve, reject) => {
        settle = resolve;
        job.onmessage = (event: MessageEvent<{ type: 'progress'; done: number; total: number } | { type: 'done'; result: ExposureResult }>) => {
          if (worker !== job) return;
          const message = event.data;
          if (message.type === 'progress') {
            onProgress(message.total > 0 ? message.done / message.total : 1);
            return;
          }
          job.terminate();
          worker = null;
          settle = null;
          resolve(message.result);
        };
        job.onerror = (event) => {
          if (worker !== job) return;
          job.terminate();
          worker = null;
          settle = null;
          reject(new Error(event.message || 'The sunlight calculation stopped.'));
        };
        // The sky samples stay with the caller for the next run, so only the rest is moved.
        const { points, normals, occluders } = input;
        job.postMessage(input, [points.buffer, normals.buffer, occluders.solid.buffer, occluders.evergreen.buffer, occluders.deciduous.buffer]);
      });
    },
  };
}
