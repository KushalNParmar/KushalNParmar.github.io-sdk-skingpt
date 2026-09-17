import { NanoTrackCore } from './nanotrack-core.js';
import { FeatureTracker } from './feature-tracker.js';
import { loadOpenCV } from './opencv-runtime.js';
import { TrackingFusion } from './tracking-math.js';

function stoppedError() { const error = new Error('Object tracking was stopped.'); error.name = 'AbortError'; return error; }

/** NanoTrack supplies the appearance search; geometric evidence refines trusted frames. */
export class HybridTrackCore {
  constructor(ort, options = {}) {
    this.nano = new NanoTrackCore(ort, options);
    this.options = options;
    this.fusion = new TrackingFusion(options.fusion);
    this.destroyed = false;
  }

  init() {
    if (!this.initializing) this.initializing = Promise.all([
      this.nano.init(),
      loadOpenCV(this.options.opencvUrl).then(({ cv }) => {
        if (!this.destroyed) this.features = new FeatureTracker(cv);
      }).catch(error => { this.featuresWarning = error?.message || 'Visual feature refinement is unavailable.'; }),
    ]).then(() => {
      if (this.destroyed) throw stoppedError();
      return { ready: true, featuresAvailable: !!this.features, featuresWarning: this.featuresWarning || null };
    });
    return this.initializing;
  }

  perform(operation) {
    if (this.destroyed) return Promise.reject(stoppedError());
    this.operation = Promise.resolve().then(operation);
    return this.operation;
  }

  select(frame, box) {
    return this.perform(async () => {
      const started = performance.now();
      this.referenceBox = null;
      this.features?.reset();
      const image = this.nano.readFrame(frame);
      const result = await this.nano.select(image, box);
      if (this.destroyed) throw stoppedError();
      let feature;
      try { feature = this.features?.select(image, box); }
      catch (error) { this.disableFeatures(error); }
      this.referenceBox = { ...box };
      this.frameWidth = image.width;
      this.frameHeight = image.height;
      this.fusion.select(box, !!feature?.reliable, performance.now());
      return this.decorate({ ...result, ...this.fusion.accept(box, feature?.reliable ? 'hybrid' : 'nanotrack', feature?.reliable ? feature : null) }, started);
    });
  }

  update(frame) {
    return this.perform(async () => {
      if (!this.referenceBox) throw new Error('Select an object before starting tracking.');
      const started = performance.now();
      const image = this.nano.readFrame(frame);
      const nano = await this.nano.update(image);
      if (this.destroyed) throw stoppedError();
      let feature;
      try { feature = this.features?.update(image, nano, performance.now()); }
      catch (error) { this.disableFeatures(error); }
      const result = this.fusion.update(nano, feature, performance.now());
      if (result.reliable && result.homography) this.features?.commitGeometry?.(result);
      else if (!result.reliable || feature?.reliable) this.features?.rejectGeometry?.();
      // NanoTrack normally updates its search box during inference. Roll back a
      // rejected candidate, or align its next search with corroborated geometry.
      this.nano.setSearchBox(this.fusion.lastBox);
      return this.decorate({ ...nano, ...result }, started);
    });
  }

  decorate(result, started) {
    return { ...result, inferenceMs: performance.now() - started, featuresAvailable: !!this.features,
      featuresWarning: this.featuresWarning || null, referenceBox: { ...this.referenceBox },
      frameWidth: this.frameWidth, frameHeight: this.frameHeight };
  }

  disableFeatures(error) {
    this.features?.destroy();
    this.features = null;
    this.featuresWarning = error?.message || 'Visual feature refinement is unavailable.';
    this.fusion.featureCapable = false;
  }

  async reset() {
    await this.operation?.catch(() => {});
    this.features?.reset();
    this.referenceBox = null;
    await this.nano.reset();
  }

  async destroy() {
    if (this.destroyed) return this.cleanup;
    this.destroyed = true;
    this.features?.destroy();
    this.features = null;
    this.cleanup = this.nano.destroy();
    return this.cleanup;
  }
}
