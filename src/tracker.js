// The WebAR.rocks core is a singleton, even when multiple UI instances exist.
let activeTracker = null;

const CORE_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 60_000;

const SCAN_SETTINGS = {
  nScaleLevels: 2,
  scale0Factor: 0.8,
  overlapFactors: [2, 2, 2],
  scanCenterFirst: true,
};

const LOAD_OPTIONS = {
  notHereFactor: 0,
  paramsPerLabel: { CUP: { thresholdDetect: 0.92 } },
};

const DETECT_OPTIONS = {
  isKeepTracking: true,
  isSkipConfirmation: false,
  thresholdDetectFactor: 1,
  cutShader: 'median',
  thresholdDetectFactorUnstitch: 0.2,
  trackingFactors: [0.5, 0.4, 1.5],
};

function trackingError(code, context, cause) {
  const details = {
    GL_INCOMPATIBLE: 'WebGL support is unavailable or insufficient for cup tracking.',
    GLCONTEXT_LOST: 'The tracking graphics context was lost. Reload to restart the camera experience.',
    ALREADY_INITIALIZED: 'The tracking engine is already in use.',
    INVALID_CANVASID: 'The tracking canvas could not be found.',
    INVALID_NN: 'The cup tracking network is invalid or corrupted.',
    NOTFOUND_NN: 'The cup tracking network could not be loaded.',
    CORE_TIMEOUT: 'The tracking engine did not finish starting. Reload and try again.',
    NETWORK_TIMEOUT: 'The cup tracking network did not finish loading. Reload and try again.',
    NOT_READY: 'The cup tracker has not finished starting.',
    DESTROYED: 'Cup tracking was stopped.',
    MISSING_ENGINE: 'The cup tracking script did not load. Check the connection and reload.',
    INVALID_INPUT: 'A camera video, tracking canvas, and parsed cup network are required.',
  };
  const error = new Error(`${details[code] || 'Cup tracking failed.'} (${context}: ${code})`);
  error.name = 'CupTrackingError';
  error.code = code;
  error.context = context;
  if (cause) error.cause = cause;
  return error;
}

export class CupTracker {
  constructor({ video, canvas, onFatal = () => {} }) {
    this.video = video;
    this.canvas = canvas;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.onFatal = onFatal;
    this.api = null;
    this.initialized = false;
    this.ready = false;
    this.stopped = false;
    this.failed = false;
    this.initPromise = null;
    this.destroyPromise = null;
    this.pendingReject = null;
    this.timer = null;
  }

  async init(network) {
    if (this.stopped) throw trackingError('DESTROYED', 'initialization');
    if (this.initPromise) return this.initPromise;
    if (!this.video || !this.canvas || !network || typeof network !== 'object') {
      throw trackingError('INVALID_INPUT', 'initialization');
    }
    const api = typeof window !== 'undefined' && window.WEBARROCKSOBJECT;
    if (!api) throw trackingError('MISSING_ENGINE', 'initialization');
    if (activeTracker && activeTracker !== this) {
      throw trackingError('ALREADY_INITIALIZED', 'initialization');
    }
    activeTracker = this;
    this.api = api;
    this.initPromise = this.start(network);
    return this.initPromise;
  }

  async start(network) {
    try {
      this.videoWidth = this.video.videoWidth;
      this.videoHeight = this.video.videoHeight;
      await this.waitForCallback('initialization', CORE_TIMEOUT_MS, 'CORE_TIMEOUT', (done) => {
        this.api.init({
          video: this.video,
          canvas: this.canvas,
          isDebugRender: false,
          followZRot: true,
          scanSettings: structuredClone(SCAN_SETTINGS),
          callbackReady: (code) => {
            // The engine reuses this callback for context loss after startup.
            if (code && this.initialized) {
              this.fatal(trackingError(code, 'graphics context'));
              return;
            }
            if (!code && !this.failed && !this.stopped) this.initialized = true;
            done(code);
          },
        });
      });
      if (this.stopped || this.failed) throw trackingError('DESTROYED', 'initialization');
      await this.waitForCallback('network loading', NETWORK_TIMEOUT_MS, 'NETWORK_TIMEOUT', (done) => {
        this.api.set_NN(network, done, structuredClone(LOAD_OPTIONS));
      });
      if (this.stopped || this.failed) throw trackingError('DESTROYED', 'network loading');
      this.ready = true;
      return this;
    } catch (error) {
      this.failed = true;
      this.ready = false;
      // An initialized core remains reserved until destroy() completes.
      if (!this.initialized && activeTracker === this) activeTracker = null;
      throw error;
    }
  }

  waitForCallback(context, timeoutMs, timeoutCode, invoke) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.timer);
        this.timer = null;
        this.pendingReject = null;
        if (error) reject(error);
        else resolve();
      };
      this.pendingReject = (error) => settle(error);
      this.timer = setTimeout(() => settle(trackingError(timeoutCode, context)), timeoutMs);
      try {
        invoke((code) => settle(code ? trackingError(code, context) : null));
      } catch (cause) {
        settle(trackingError(cause.code || 'ENGINE_ERROR', context, cause));
      }
    });
  }

  step() {
    if (!this.ready || this.stopped || this.failed) {
      throw trackingError('NOT_READY', 'detection');
    }
    try {
      // Phone rotation can change the source's intrinsic dimensions. The core
      // otherwise keeps the old aspect ratio and scan grid from initialization.
      const width = this.video.videoWidth;
      const height = this.video.videoHeight;
      if (width > 0 && height > 0 && (width !== this.videoWidth || height !== this.videoHeight)) {
        this.api.set_source(this.video);
        this.api.reset_state();
        this.videoWidth = width;
        this.videoHeight = height;
      }
      const state = this.api.detect(0, null, DETECT_OPTIONS);
      // detect() reuses its own object and positionScale array each frame.
      return {
        label: state.label || false,
        score: state.detectScore ?? 0,
        positionScale: state.positionScale ? Array.from(state.positionScale) : [0, 0, 0, 0],
        pitch: state.pitch,
        yaw: state.yaw,
        roll: state.roll,
      };
    } catch (cause) {
      const error = trackingError(cause.code || 'DETECTION_ERROR', 'detection', cause);
      this.fatal(error);
      throw error;
    }
  }

  reset() {
    if (this.ready && !this.stopped && !this.failed) this.api.reset_state();
  }

  fatal(error) {
    if (this.stopped || this.failed) return;
    this.failed = true;
    this.ready = false;
    if (this.pendingReject) this.pendingReject(error);
    this.onFatal(error);
  }

  async destroy() {
    if (this.destroyPromise) return this.destroyPromise;
    this.stopped = true;
    this.ready = false;
    if (this.pendingReject) this.pendingReject(trackingError('DESTROYED', 'cleanup'));
    this.destroyPromise = (async () => {
      try {
        if (this.initialized) await this.api.destroy();
      } finally {
        this.initialized = false;
        if (activeTracker === this) activeTracker = null;
      }
    })();
    return this.destroyPromise;
  }
}
