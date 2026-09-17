// NanoTrack V2 postprocessing follows HonglinChu/SiamTrackers' NanoTracker and
// configv2.yaml (Apache-2.0). The deployed model consumes RGB, raw 0..255, NCHW.
// This is a single-object 2D tracker: the score is not a calibrated probability.
const TEMPLATE_SIZE = 127;
const SEARCH_SIZE = 255;
const RESPONSE_SIZE = 16;
const STRIDE = 16;
const CONTEXT = 0.5;
const PENALTY_K = 0.150;
const WINDOW_INFLUENCE = 0.490;
const SIZE_LEARNING_RATE = 0.385;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const change = value => Math.max(value, 1 / value);
const sizeWithContext = (width, height) => {
  const padding = (width + height) / 2;
  return Math.sqrt((width + padding) * (height + padding));
};
const window2d = Float32Array.from({ length: RESPONSE_SIZE * RESPONSE_SIZE }, (_, index) => {
  const hann = n => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (RESPONSE_SIZE - 1));
  return hann(index % RESPONSE_SIZE) * hann(Math.floor(index / RESPONSE_SIZE));
});

function dispose(tensor) { tensor?.dispose?.(); }
function selectionError(message) { const error = new Error(message); error.name = 'SelectionError'; return error; }
function stoppedError() { const error = new Error('Object tracking was stopped.'); error.name = 'AbortError'; return error; }
function disposeOutputs(outputs, except) {
  for (const tensor of Object.values(outputs || {})) if (tensor !== except) dispose(tensor);
}

function regionContrast(image, box) {
  const left = clamp(Math.floor(box.x), 0, image.width - 1);
  const top = clamp(Math.floor(box.y), 0, image.height - 1);
  const right = clamp(Math.ceil(box.x + box.width), left + 1, image.width);
  const bottom = clamp(Math.ceil(box.y + box.height), top + 1, image.height);
  let sum = 0, squares = 0, count = 0;
  for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
    const index = (y * image.width + x) * 4;
    const value = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
    sum += value; squares += value * value; ++count;
  }
  return Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
}

/** Exported for regression checks against exact pixels, boundaries and tensor layout. */
export function cropCHW(image, cx, cy, originalSize, outputSize, average) {
  const side = Math.max(1, Math.round(originalSize));
  const left = Math.floor(cx - (side + 1) / 2 + 0.5);
  const top = Math.floor(cy - (side + 1) / 2 + 0.5);
  const area = outputSize * outputSize;
  const values = new Float32Array(3 * area);
  const pixel = (x, y, channel) => x < 0 || y < 0 || x >= image.width || y >= image.height
    ? average[channel] : image.data[(y * image.width + x) * 4 + channel];
  for (let oy = 0; oy < outputSize; ++oy) {
    const sy = clamp((oy + 0.5) * side / outputSize - 0.5, 0, side - 1);
    const y0 = Math.floor(sy), y1 = Math.min(side - 1, y0 + 1), dy = sy - y0;
    for (let ox = 0; ox < outputSize; ++ox) {
      const sx = clamp((ox + 0.5) * side / outputSize - 0.5, 0, side - 1);
      const x0 = Math.floor(sx), x1 = Math.min(side - 1, x0 + 1), dx = sx - x0;
      const index = oy * outputSize + ox;
      for (let channel = 0; channel < 3; ++channel) {
        const a = pixel(left + x0, top + y0, channel) * (1 - dx) + pixel(left + x1, top + y0, channel) * dx;
        const b = pixel(left + x0, top + y1, channel) * (1 - dx) + pixel(left + x1, top + y1, channel) * dx;
        // OpenCV's source crop/resize is uint8 before conversion to float.
        values[channel * area + index] = Math.round(a * (1 - dy) + b * dy);
      }
    }
  }
  return values;
}

export function decodeResponse(logits, distances, state, scale, minScore) {
  const count = RESPONSE_SIZE * RESPONSE_SIZE;
  if (logits.length !== 2 * count || distances.length !== 4 * count) throw new Error('The tracker returned an unexpected response shape.');
  const previousSize = sizeWithContext(state.width * scale, state.height * scale);
  let best;
  for (let index = 0; index < count; ++index) {
    const score = 1 / (1 + Math.exp(clamp(logits[index] - logits[count + index], -80, 80)));
    const left = distances[index], top = distances[count + index];
    const right = distances[2 * count + index], bottom = distances[3 * count + index];
    const width = left + right, height = top + bottom;
    if (!(width > 0 && height > 0) || !Number.isFinite(width + height + score)) continue;
    const scaleChange = change(sizeWithContext(width, height) / previousSize);
    const ratioChange = change((state.width / state.height) / (width / height));
    const penalty = Math.exp(-(scaleChange * ratioChange - 1) * PENALTY_K);
    const rank = score * penalty * (1 - WINDOW_INFLUENCE) + window2d[index] * WINDOW_INFLUENCE;
    if (!best || rank > best.rank) {
      const px = (index % RESPONSE_SIZE - RESPONSE_SIZE / 2) * STRIDE;
      const py = (Math.floor(index / RESPONSE_SIZE) - RESPONSE_SIZE / 2) * STRIDE;
      best = { score, rank, penalty, width, height, dx: (px + (right - left) / 2) / scale, dy: (py + (bottom - top) / 2) / scale };
    }
  }
  const previousBox = { x: state.cx - state.width / 2, y: state.cy - state.height / 2, width: state.width, height: state.height };
  if (!best) return { box: previousBox, score: 0, reliable: false, reason: 'invalid-response' };
  const sizeRatio = best.width * best.height / (scale * scale * state.width * state.height);
  const cx = state.cx + best.dx, cy = state.cy + best.dy;
  // Keep the last trusted search location. Never adapt the reference to a doubtful frame.
  const reliable = best.score >= minScore && best.penalty > 0.35 && sizeRatio > 0.20 && sizeRatio < 5
    && cx >= 0 && cy >= 0 && cx <= state.frameWidth && cy <= state.frameHeight;
  if (!reliable) return { box: previousBox, score: best.score, reliable: false, reason: 'low-confidence' };
  const lr = best.penalty * best.score * SIZE_LEARNING_RATE;
  const width = clamp(state.width * (1 - lr) + best.width / scale * lr, 10, state.frameWidth);
  const height = clamp(state.height * (1 - lr) + best.height / scale * lr, 10, state.frameHeight);
  return { box: { x: cx - width / 2, y: cy - height / 2, width, height }, score: best.score, reliable: true };
}

export class NanoTrackCore {
  constructor(ort, options) {
    if (!ort) throw new Error('The local inference runtime is unavailable.');
    this.ort = ort;
    this.options = options;
    this.abortController = new AbortController();
    this.destroyed = false;
  }

  init() {
    if (this.destroyed) return Promise.reject(stoppedError());
    if (!this.initializing) this.initializing = this.initialize();
    return this.initializing;
  }

  async initialize() {
    this.ort.env.wasm.numThreads = 1;
    this.ort.env.wasm.proxy = false;
    this.ort.env.wasm.wasmPaths = this.options.wasmPath;
    const load = async url => {
      const response = await fetch(url, { signal: this.abortController.signal });
      if (!response.ok) throw new Error(`A tracking model could not load (${response.status}). Please retry.`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [backboneBytes, headBytes] = await Promise.all([load(this.options.backboneUrl), load(this.options.headUrl)]);
    const sessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
    this.backbone = await this.ort.InferenceSession.create(backboneBytes, sessionOptions);
    if (this.destroyed) throw stoppedError();
    this.head = await this.ort.InferenceSession.create(headBytes, sessionOptions);
    if (this.destroyed) throw stoppedError();
    if (this.backbone.inputNames.length !== 1 || !this.head.inputNames.includes('input1') || !this.head.inputNames.includes('input2')) throw new Error('The tracking models have an unsupported input layout.');
  }

  readFrame(frame) {
    // Hybrid tracking shares one camera read between ONNX and OpenCV.
    if (frame?.data && frame.data.length === frame.width * frame.height * 4) return frame;
    if (!this.canvas) {
      this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(frame.width, frame.height);
      this.context = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
      if (!this.context) throw new Error('This browser cannot read camera frames for tracking.');
    }
    if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
    if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
    this.context.drawImage(frame, 0, 0);
    return this.context.getImageData(0, 0, frame.width, frame.height);
  }

  tensor(image, size, originalSize) {
    return new this.ort.Tensor('float32', cropCHW(image, this.state.cx, this.state.cy, originalSize, size, this.average), [1, 3, size, size]);
  }

  perform(operation) {
    if (this.destroyed) return Promise.reject(stoppedError());
    // Retain the raw inference promise even if the public wrapper times out.
    // Cleanup may release a session only after its actual ONNX operation settles.
    this.operation = Promise.resolve().then(operation);
    return this.operation;
  }

  select(frame, box) { return this.perform(() => this.selectFrame(frame, box)); }
  update(frame) { return this.perform(() => this.updateFrame(frame)); }

  async selectFrame(frame, box) {
    this.clearTemplate();
    if (!this.backbone || this.destroyed) throw new Error('The tracking models are not ready.');
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 12 || box.height < 12 || box.x < 0 || box.y < 0 || box.x + box.width > frame.width + 1 || box.y + box.height > frame.height + 1) throw selectionError('Draw a larger rectangle inside the camera image.');
    const started = performance.now();
    const image = this.readFrame(frame);
    this.referenceContrast = regionContrast(image, box);
    if (this.referenceContrast < 2) throw selectionError('This selection has too little visual detail. Include the object edges and select again.');
    const average = [0, 0, 0];
    for (let index = 0; index < image.data.length; index += 4) for (let channel = 0; channel < 3; ++channel) average[channel] += image.data[index + channel];
    const pixels = image.width * image.height;
    this.average = average.map(value => Math.floor(value / pixels));
    this.state = { cx: box.x + (box.width - 1) / 2, cy: box.y + (box.height - 1) / 2, width: box.width, height: box.height, frameWidth: image.width, frameHeight: image.height };
    const context = CONTEXT * (box.width + box.height);
    const template = this.tensor(image, TEMPLATE_SIZE, Math.sqrt((box.width + context) * (box.height + context)));
    let outputs;
    try {
      outputs = await this.backbone.run({ [this.backbone.inputNames[0]]: template });
      if (this.destroyed) throw stoppedError();
      this.template = outputs[this.backbone.outputNames[0]];
      if (this.template.dims[2] !== 8 || this.template.dims[3] !== 8) throw new Error('The tracking template has an unsupported shape.');
      return { box: { ...box }, score: 1, reliable: true, inferenceMs: performance.now() - started };
    } catch (error) { disposeOutputs(outputs); outputs = null; this.template = null; this.state = null; throw error; }
    finally { dispose(template); disposeOutputs(outputs, this.template); }
  }

  async updateFrame(frame) {
    if (!this.template || !this.state || this.destroyed) throw new Error('Select an object before starting tracking.');
    if (frame.width !== this.state.frameWidth || frame.height !== this.state.frameHeight) throw new Error('The camera image size changed. Please select the object again.');
    const started = performance.now();
    const image = this.readFrame(frame);
    const context = CONTEXT * (this.state.width + this.state.height);
    const originalTemplateSize = Math.sqrt((this.state.width + context) * (this.state.height + context));
    const scale = TEMPLATE_SIZE / originalTemplateSize;
    const search = this.tensor(image, SEARCH_SIZE, originalTemplateSize * SEARCH_SIZE / TEMPLATE_SIZE);
    let features, outputs;
    try {
      features = await this.backbone.run({ [this.backbone.inputNames[0]]: search });
      if (this.destroyed) throw stoppedError();
      outputs = await this.head.run({ input1: this.template, input2: features[this.backbone.outputNames[0]] });
      if (this.destroyed) throw stoppedError();
      const classification = Object.values(outputs).find(tensor => tensor.dims[1] === 2);
      const regression = Object.values(outputs).find(tensor => tensor.dims[1] === 4);
      if (!classification || !regression) throw new Error('The tracker returned unsupported output tensors.');
      const result = decodeResponse(classification.data, regression.data, this.state, scale, this.options.minScore ?? 0.80);
      if (result.reliable && regionContrast(image, result.box) < Math.max(2, this.referenceContrast * 0.08)) {
        result.box = { x: this.state.cx - this.state.width / 2, y: this.state.cy - this.state.height / 2, width: this.state.width, height: this.state.height };
        result.reliable = false;
        result.reason = 'insufficient-detail';
      }
      if (result.reliable) {
        this.state.cx = result.box.x + result.box.width / 2;
        this.state.cy = result.box.y + result.box.height / 2;
        this.state.width = result.box.width;
        this.state.height = result.box.height;
      }
      return { ...result, inferenceMs: performance.now() - started };
    } finally { dispose(search); disposeOutputs(features); disposeOutputs(outputs); }
  }

  clearTemplate() { dispose(this.template); this.template = null; this.state = null; }

  setSearchBox(box) {
    if (!this.state || !box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)
      || box.width < 10 || box.height < 10) return;
    // Correct the next search location without changing the selected template.
    this.state.cx = clamp(box.x + box.width / 2, 0, this.state.frameWidth);
    this.state.cy = clamp(box.y + box.height / 2, 0, this.state.frameHeight);
    this.state.width = clamp(box.width, 10, this.state.frameWidth);
    this.state.height = clamp(box.height, 10, this.state.frameHeight);
  }

  async reset() {
    await this.operation?.catch(() => {});
    this.clearTemplate();
  }

  async destroy() {
    if (this.destroyed) return this.boundedCleanup;
    this.destroyed = true;
    this.abortController.abort();
    const cleanup = (async () => {
      await Promise.allSettled([this.initializing, this.operation]);
      this.clearTemplate();
      await Promise.allSettled([this.backbone?.release(), this.head?.release()]);
      this.backbone = this.head = this.canvas = this.context = null;
    })();
    // A hung WASM call must not block closing the UI. Its resources stay owned
    // until it settles; releasing tensors or sessions underneath it is unsafe.
    this.boundedCleanup = new Promise(resolve => {
      const timer = setTimeout(resolve, 2_000);
      const finished = () => { clearTimeout(timer); resolve(); };
      cleanup.then(finished, finished);
    });
    return this.boundedCleanup;
  }
}
