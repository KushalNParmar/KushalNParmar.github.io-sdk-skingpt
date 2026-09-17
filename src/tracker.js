const INITIALIZE_TIMEOUT = 60_000;
const INFERENCE_TIMEOUT = 15_000;
let runtimePromise;

function loadRuntime() {
  if (globalThis.ort) return Promise.resolve(globalThis.ort);
  if (!runtimePromise) runtimePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const fail = () => { clearTimeout(timer); runtimePromise = null; script.remove(); reject(new Error('The local inference runtime could not load. Check your connection and retry.')); };
    const timer = setTimeout(fail, 20_000);
    script.src = new URL('../vendor/onnx/ort.min.js', import.meta.url).href;
    script.onload = () => { clearTimeout(timer); if (globalThis.ort) resolve(globalThis.ort); else fail(); };
    script.onerror = fail;
    document.head.append(script);
  });
  return runtimePromise;
}

function stoppedError() {
  const error = new Error('Object tracking was stopped.');
  error.name = 'AbortError';
  return error;
}

/** Selection-based hybrid tracking. All geometry uses supplied canvas pixels. */
export class ObjectTracker {
  constructor({ onFatal, minScore = 0.80 } = {}) {
    this.onFatal = onFatal;
    this.options = {
      backboneUrl: new URL('../assets/nanotrack/backbone.onnx', import.meta.url).href,
      headUrl: new URL('../assets/nanotrack/head.onnx', import.meta.url).href,
      wasmPath: new URL('../vendor/onnx/', import.meta.url).href,
      opencvUrl: new URL('../vendor/opencv/opencv.js', import.meta.url).href,
      minScore,
    };
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
    this.ready = false;
    this.destroyed = false;
    this.busy = false;
  }

  async init() {
    if (this.destroyed) throw stoppedError();
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize().catch(async error => {
      await this.core?.destroy();
      this.core = null;
      this.initPromise = null;
      throw error;
    });
    return this.initPromise;
  }

  async initialize() {
    const canUseWorker = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap === 'function';
    if (canUseWorker) {
      try {
        this.worker = new Worker(new URL('./nanotrack.worker.js', import.meta.url));
        this.worker.onmessage = ({ data }) => {
          const pending = this.pending.get(data.id);
          if (!pending) return;
          this.pending.delete(data.id);
          clearTimeout(pending.timer);
          if (data.error) { const error = new Error(data.error); error.name = data.errorName || 'Error'; pending.reject(error); }
          else pending.resolve(data.result);
        };
        this.worker.onerror = () => this.rejectWorker(new Error('The object-tracking worker stopped. Please restart the camera.'));
        const capabilities = await this.callWorker('init', { options: this.options }, [], INITIALIZE_TIMEOUT);
        if (this.destroyed) throw stoppedError();
        this.mode = 'worker';
        this.featuresAvailable = capabilities.featuresAvailable;
        this.featuresWarning = capabilities.featuresWarning;
        this.ready = true;
        return;
      } catch (error) {
        this.worker?.terminate();
        this.worker = null;
        this.rejectWorker(error);
        if (this.destroyed) throw stoppedError();
        this.workerFallbackReason = error.message;
      }
    }
    const [{ HybridTrackCore }, ort] = await Promise.all([import('./hybrid-core.js'), loadRuntime()]);
    if (this.destroyed) throw stoppedError();
    this.core = new HybridTrackCore(ort, this.options);
    const capabilities = await this.withTimeout(this.core.init(), INITIALIZE_TIMEOUT, 'The tracking models took too long to load. Please retry.');
    if (this.destroyed) { await this.core.destroy(); throw stoppedError(); }
    this.mode = 'main';
    this.featuresAvailable = capabilities.featuresAvailable;
    this.featuresWarning = capabilities.featuresWarning;
    this.ready = true;
  }

  rejectWorker(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    if (this.ready && !this.destroyed) {
      this.ready = false;
      this.onFatal?.(error);
    }
  }

  callWorker(type, payload = {}, transfer = [], timeout = INFERENCE_TIMEOUT) {
    if (!this.worker || this.destroyed) return Promise.reject(stoppedError());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(type === 'init' ? 'The tracking models took too long to load. Please retry.' : 'Object tracking stopped responding. Please restart the camera.');
        this.worker?.terminate();
        this.worker = null;
        this.rejectWorker(error);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, type, ...payload }, transfer); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async withTimeout(promise, milliseconds, message) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
    } finally { clearTimeout(timer); }
  }

  process(type, canvas, box) {
    if (this.destroyed) throw stoppedError();
    if (!this.ready) throw new Error('Object tracking is not ready yet.');
    if (this.busy) throw new Error('An object-tracking frame is already being processed.');
    if (!(canvas?.width > 0 && canvas?.height > 0)) throw new Error('A camera frame is required.');
    const generation = this.generation;
    this.busy = true;
    this.activeOperation = (async () => {
      try {
        let result;
        if (this.worker) {
          const frame = await createImageBitmap(canvas);
          if (generation !== this.generation || this.destroyed) { frame.close(); throw stoppedError(); }
          try { result = await this.callWorker(type, { frame, box }, [frame]); }
          finally { frame.close(); }
        } else {
          result = await this.withTimeout(this.core[type](canvas, box), INFERENCE_TIMEOUT, 'Object tracking stopped responding. Please restart the camera.');
        }
        if (generation !== this.generation || this.destroyed) throw stoppedError();
        return result;
      } finally { this.busy = false; }
    })();
    return this.activeOperation;
  }

  select(canvas, box) { return this.process('select', canvas, box); }
  update(canvas) { return this.process('update', canvas); }

  async reset() {
    ++this.generation;
    if (this.destroyed || !this.ready) return;
    if (this.worker) await this.callWorker('reset');
    else await this.withTimeout(this.core.reset(), INFERENCE_TIMEOUT, 'Object tracking stopped responding. Please restart the camera.');
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ready = false;
    ++this.generation;
    this.rejectWorker(stoppedError());
    this.worker?.terminate();
    this.worker = null;
    await this.core?.destroy();
  }
}
