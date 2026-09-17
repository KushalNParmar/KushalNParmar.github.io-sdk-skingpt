// Geometry is in processing-frame pixels. None of these values is a metric 3D pose.
export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
export const boxQuad = box => [
  { x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
  { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height },
];
export const boxCenter = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
export const boxDiagonal = box => Math.hypot(box.width, box.height);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const finiteBox = box => !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width >= 10 && box.height >= 10;

export function project(h, point) {
  const w = h[6] * point.x + h[7] * point.y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-7) return null;
  const p = { x: (h[0] * point.x + h[1] * point.y + h[2]) / w, y: (h[3] * point.x + h[4] * point.y + h[5]) / w };
  return Number.isFinite(p.x + p.y) ? p : null;
}

export function quadBounds(quad) {
  const xs = quad.map(p => p.x), ys = quad.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function polygonArea(quad) {
  return quad.reduce((sum, p, i) => {
    const q = quad[(i + 1) % quad.length];
    return sum + p.x * q.y - q.x * p.y;
  }, 0) / 2;
}

export function boxOverlap(a, b) {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}

export function boxesAgree(a, b) {
  if (!finiteBox(a) || !finiteBox(b)) return false;
  const areaRatio = a.width * a.height / (b.width * b.height);
  return areaRatio > 0.32 && areaRatio < 3.1 && (boxOverlap(a, b) >= 0.22
    || distance(boxCenter(a), boxCenter(b)) < Math.min(boxDiagonal(a), boxDiagonal(b)) * 0.33);
}

export function plausibleStep(previous, next, allowance = 1) {
  if (!finiteBox(previous) || !finiteBox(next)) return false;
  const ratio = next.width * next.height / (previous.width * previous.height);
  return ratio > 0.38 && ratio < 2.65
    && distance(boxCenter(previous), boxCenter(next)) <= Math.max(35, boxDiagonal(previous) * 0.65) * allowance;
}

// A cluster along one edge is not enough to infer perspective reliably.
export function spatialCoverage(points, box) {
  if (points.length < 4) return 0;
  const bounds = quadBounds(points);
  const coverage = Math.min(1, bounds.width / box.width) * Math.min(1, bounds.height / box.height);
  const cells = new Set(points.map(p => `${Math.max(0, Math.min(2, Math.floor((p.x - box.x) / box.width * 3)))},${Math.max(0, Math.min(2, Math.floor((p.y - box.y) / box.height * 3)))}`));
  let xx = 0, yy = 0, xy = 0;
  const mean = points.reduce((sum, p) => ({ x: sum.x + p.x / points.length, y: sum.y + p.y / points.length }), { x: 0, y: 0 });
  for (const p of points) { const x = (p.x - mean.x) / box.width, y = (p.y - mean.y) / box.height; xx += x * x; yy += y * y; xy += x * y; }
  const determinant = xx * yy - xy * xy;
  if (cells.size < 4 || determinant < 0.015 || determinant / Math.max(1e-6, (xx + yy) ** 2) < 0.035) return 0;
  return coverage;
}

export function validateHomography(h, referenceBox, frameWidth, frameHeight, previousBox = null) {
  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return null;
  const corners = boxQuad(referenceBox);
  const denominators = corners.map(p => h[6] * p.x + h[7] * p.y + h[8]);
  if (denominators.some(w => Math.abs(w) < 1e-7) || denominators.some(w => Math.sign(w) !== Math.sign(denominators[0]))) return null;
  const quad = corners.map(p => project(h, p));
  if (quad.some(p => !p)) return null;
  // A valid visible plane preserves convexity and orientation; reject folds/reflections.
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 1) return null;
  }
  const area = polygonArea(quad), box = quadBounds(quad), center = boxCenter(box);
  const ratio = area / (referenceBox.width * referenceBox.height);
  if (!finiteBox(box) || ratio < 0.10 || ratio > 10 || area / (box.width * box.height) < 0.22
    || center.x < 0 || center.y < 0 || center.x > frameWidth || center.y > frameHeight
    || quad.some(p => p.x < -frameWidth * 0.3 || p.x > frameWidth * 1.3 || p.y < -frameHeight * 0.3 || p.y > frameHeight * 1.3)
    || previousBox && !plausibleStep(previousBox, box)) return null;
  return { quad, box };
}

export function boxTransform(from, to) {
  const sx = to.width / from.width, sy = to.height / from.height;
  return [sx, 0, to.x - from.x * sx, 0, sy, to.y - from.y * sy, 0, 0, 1];
}

/** Confidence gates rather than a weighted average of contradictory estimates. */
export class TrackingFusion {
  constructor({ maxFeatureOnlyMs = 1200, maxFeatureOnlyFrames = 12, maxNanoOnlyMs = 1400, recoveryWindowMs = 3500 } = {}) {
    Object.assign(this, { maxFeatureOnlyMs, maxFeatureOnlyFrames, maxNanoOnlyMs, recoveryWindowMs });
  }

  select(box, featureCapable, now = 0) {
    this.lastBox = { ...box };
    this.featureCapable = featureCapable;
    this.lastAgreement = now;
    this.lastFeatures = now;
    this.featureOnlyFrames = 0;
    this.nanoOnlyStrongFrames = 0;
    this.misses = 0;
    this.lostAt = null;
    this.recoveryCandidate = null;
  }

  update(nano, feature, now) {
    let hasFeature = !!feature?.reliable && finiteBox(feature.box) && plausibleStep(this.lastBox, feature.box, this.misses ? 1.6 : 1);
    const hasNano = !!nano?.reliable && finiteBox(nano.box) && plausibleStep(this.lastBox, nano.box, this.misses ? 1.35 : 1);
    if (this.lostAt !== null && now - this.lostAt > this.recoveryWindowMs) return this.miss('reselect-required', now);
    // Once geometry has been lost, only a match to the original captured pixels can restore it.
    if (this.misses && hasFeature && !feature.referenceVerified) hasFeature = false;
    const agrees = hasNano && hasFeature && boxesAgree(nano.box, feature.box);
    if (agrees) {
      this.lastAgreement = this.lastFeatures = now;
      this.featureOnlyFrames = 0;
      this.nanoOnlyStrongFrames = 0;
      return this.accept(feature.box, 'hybrid', feature);
    }
    if (hasFeature) {
      this.nanoOnlyStrongFrames = 0;
      this.lastFeatures = now;
      ++this.featureOnlyFrames;
      if (now - this.lastAgreement <= this.maxFeatureOnlyMs && this.featureOnlyFrames <= this.maxFeatureOnlyFrames && !this.misses) return this.accept(feature.box, 'features', feature);
      return this.miss('trackers-disagree', now);
    }
    if (hasNano) {
      this.nanoOnlyStrongFrames = nano.score >= 0.88 && boxesAgree(this.lastBox, nano.box) ? this.nanoOnlyStrongFrames + 1 : 0;
      // A changed viewpoint can leave too few reference matches for orientation.
      // Strong local NanoTrack estimates may continue only with fresh evidence
      // from the ORIGINAL image, never on a high appearance score alone.
      if (this.featureCapable && (this.misses || now - this.lastFeatures > this.maxNanoOnlyMs
        && (this.nanoOnlyStrongFrames < 3 || !(feature?.referenceEvidence >= 6)))) return this.miss('visual-detail-lost', now);
      if (this.misses) {
        // A high NanoTrack score alone is not identity proof. Demand stable consecutive
        // local candidates for low-texture targets, and stop the search after a timeout.
        if (nano.score < 0.90) return this.miss('confirming-recovery', now);
        if (!this.recoveryCandidate || !boxesAgree(this.recoveryCandidate, nano.box)) {
          this.recoveryCandidate = { ...nano.box };
          return this.miss('confirming-recovery', now, true);
        }
      }
      this.featureOnlyFrames = 0;
      this.lastAgreement = now;
      return this.accept(nano.box, 'nanotrack', null);
    }
    return this.miss(nano?.reason || feature?.reason || 'low-confidence', now);
  }

  accept(box, trackingMode, feature) {
    this.lastBox = { ...box };
    this.misses = 0;
    this.lostAt = null;
    this.recoveryCandidate = null;
    return { box: { ...box }, reliable: true, trackingMode, quad: feature?.quad || null, homography: feature?.homography || null,
      featureCount: feature?.featureCount || 0, inlierRatio: feature?.inlierRatio || 0,
      geometryConfidence: feature ? Math.min(1, feature.featureCount / 24) * feature.inlierRatio : 0 };
  }

  miss(reason, now, keepCandidate = false) {
    ++this.misses;
    this.lostAt ??= now;
    if (!keepCandidate) this.recoveryCandidate = null;
    this.nanoOnlyStrongFrames = 0;
    return { box: { ...this.lastBox }, reliable: false, reason, trackingMode: 'nanotrack', quad: null, homography: null,
      featureCount: 0, inlierRatio: 0, geometryConfidence: 0 };
  }
}
