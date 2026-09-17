/* Local worker: camera frames and model inference never leave this origin. */
importScripts('../vendor/onnx/ort.min.js');

let core;
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { id, type, frame } = data;
    try {
      let result;
      if (type === 'init') {
        if (!new OffscreenCanvas(1, 1).getContext('2d')) throw new Error('Worker canvas is unavailable.');
        const { NanoTrackCore } = await import('./nanotrack-core.js');
        core = new NanoTrackCore(self.ort, data.options);
        await core.init();
        result = { ready: true };
      } else if (!core) throw new Error('Object tracking is not initialized.');
      else if (type === 'select') result = await core.select(frame, data.box);
      else if (type === 'update') result = await core.update(frame);
      else if (type === 'reset') { await core.reset(); result = { reset: true }; }
      else throw new Error('Unknown tracker operation.');
      self.postMessage({ id, result });
    } catch (error) {
      self.postMessage({ id, error: error?.message || String(error), errorName: error?.name || 'Error' });
    } finally { frame?.close(); }
  });
};
