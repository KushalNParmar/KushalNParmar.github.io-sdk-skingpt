import { IDENTITY, boxQuad, boxTransform, project, distance, spatialCoverage, validateHomography, plausibleStep } from './tracking-math.js';

const MIN_POINTS = 12;
const MAX_POINTS = 160;
const deleteAll = resources => { for (const value of resources) value?.delete?.(); };

/** Selected-region optical flow; the original pixels and feature coordinates never adapt. */
export class FeatureTracker {
  constructor(cv) {
    this.cv = cv;
    this.reset();
  }

  gray(image) {
    const rgba = this.cv.matFromImageData(image);
    const gray = new this.cv.Mat();
    try { this.cv.cvtColor(rgba, gray, this.cv.COLOR_RGBA2GRAY); return gray; }
    catch (error) { gray.delete(); throw error; }
    finally { rgba.delete(); }
  }

  pointsMat(points) {
    return this.cv.matFromArray(points.length, 1, this.cv.CV_32FC2, points.flatMap(p => [p.x, p.y]));
  }

  select(image, box) {
    this.reset();
    this.box = { ...box };
    this.width = image.width;
    this.height = image.height;
    const cv = this.cv, gray = this.gray(image), corners = new cv.Mat();
    const mask = cv.Mat.zeros(image.height, image.width, cv.CV_8UC1);
    try {
      // Stay just inside the selection to avoid tracking the selection border/background.
      const inset = Math.max(2, Math.min(box.width, box.height) * 0.035);
      cv.rectangle(mask, new cv.Point(Math.ceil(box.x + inset), Math.ceil(box.y + inset)),
        new cv.Point(Math.floor(box.x + box.width - inset), Math.floor(box.y + box.height - inset)), new cv.Scalar(255), -1);
      cv.goodFeaturesToTrack(gray, corners, MAX_POINTS, 0.012, 5, mask, 5, false, 0.04);
      const points = [];
      for (let i = 0; i < corners.rows; i++) points.push({ x: corners.data32F[i * 2], y: corners.data32F[i * 2 + 1] });
      this.capable = points.length >= MIN_POINTS && spatialCoverage(points, box) >= 0.16;
      this.referenceGray = gray;
      this.originalPoints = points;
      if (!this.capable) return this.failure('not-enough-features');
      this.prepareDescriptors(gray, mask);
      this.previousGray = gray.clone();
      this.referencePoints = points.map(p => ({ ...p }));
      this.currentPoints = points.map(p => ({ ...p }));
      this.lastHomography = [...IDENTITY];
      this.lastBox = { ...box };
      this.trustedHomography = [...IDENTITY];
      this.trustedBox = { ...box };
      return { reliable: true, box: { ...box }, quad: boxQuad(box), homography: [...IDENTITY], featureCount: points.length,
        inlierRatio: 1, referenceVerified: true, featureMethod: 'selection' };
    } catch (error) {
      if (this.referenceGray !== gray) gray.delete();
      throw error;
    } finally { deleteAll([corners, mask]); }
  }

  failure(reason) {
    return { reliable: false, reason, featureCount: 0, inlierRatio: 0, referenceVerified: false,
      referenceEvidence: performance.now() - this.lastReferenceEvidenceAt < 750 ? this.referenceEvidence : 0 };
  }

  prepareDescriptors(gray, mask) {
    const cv = this.cv;
    if (!cv.ORB || !cv.BFMatcher || !cv.KeyPointVector || !cv.DMatchVectorVector) return;
    const keypoints = new cv.KeyPointVector();
    const descriptors = new cv.Mat();
    let orb;
    try {
      orb = new cv.ORB();
      orb.setMaxFeatures?.(400);
      orb.setEdgeThreshold?.(12);
      orb.setPatchSize?.(25);
      orb.setFastThreshold?.(12);
      orb.detectAndCompute(gray, mask, keypoints, descriptors, false);
      if (keypoints.size() < MIN_POINTS || descriptors.empty()) return;
      this.descriptorPoints = [];
      for (let i = 0; i < keypoints.size(); ++i) this.descriptorPoints.push({ ...keypoints.get(i).pt });
      this.orb = orb;
      this.descriptors = descriptors;
      this.matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
    } catch {
      // Some OpenCV builds expose the class without the required constructor.
      // Local reference-LK remains available when descriptor matching is absent.
      deleteAll([this.matcher]); this.matcher = null;
      this.orb = this.descriptors = null;
    } finally {
      keypoints.delete();
      if (this.orb !== orb) orb?.delete();
      if (this.descriptors !== descriptors) descriptors.delete();
    }
  }

  descriptorMatch(gray, nanoResult) {
    if (!this.matcher || !this.orb || !this.descriptors) return null;
    const cv = this.cv, keypoints = new cv.KeyPointVector(), descriptors = new cv.Mat(), matches = new cv.DMatchVectorVector();
    const mask = cv.Mat.zeros(this.height, this.width, cv.CV_8UC1);
    try {
      // Reacquire near the last accepted target. Never scan indefinitely for an
      // unrelated similar object elsewhere in the scene.
      const search = nanoResult?.reliable ? nanoResult.box : this.lastBox;
      const padding = Math.max(40, Math.max(search.width, search.height) * 0.7);
      cv.rectangle(mask, new cv.Point(Math.max(0, Math.floor(search.x - padding)), Math.max(0, Math.floor(search.y - padding))),
        new cv.Point(Math.min(this.width - 1, Math.ceil(search.x + search.width + padding)), Math.min(this.height - 1, Math.ceil(search.y + search.height + padding))), new cv.Scalar(255), -1);
      this.orb.detectAndCompute(gray, mask, keypoints, descriptors, false);
      if (keypoints.size() < MIN_POINTS || descriptors.empty()) return null;
      this.matcher.knnMatch(this.descriptors, descriptors, matches, 2);
      const pairs = [];
      for (let i = 0; i < matches.size(); ++i) {
        const pair = matches.get(i);
        try {
          if (pair.size() < 2) continue;
          const first = pair.get(0), second = pair.get(1);
          if (first.distance <= 54 && first.distance < second.distance * 0.72) pairs.push({ reference: first.queryIdx, current: first.trainIdx, distance: first.distance });
        } finally { pair.delete(); }
      }
      pairs.sort((a, b) => a.distance - b.distance);
      const used = new Set(), references = [], current = [];
      for (const pair of pairs) {
        if (used.has(pair.current)) continue;
        used.add(pair.current);
        references.push(this.descriptorPoints[pair.reference]);
        current.push({ ...keypoints.get(pair.current).pt });
      }
      const result = this.fit(references, current, true);
      this.recordReferenceEvidence(result || this.fit(references, current, true, 6));
      if (result) result.featureMethod = 'reference-orb';
      return result;
    } finally { deleteAll([keypoints, descriptors, matches, mask]); }
  }

  // Forward/backward consistency removes disappearing corners and many aperture ambiguities.
  flow(fromGray, toGray, fromPoints, seedPoints = null) {
    const cv = this.cv;
    const before = this.pointsMat(fromPoints);
    const after = seedPoints ? this.pointsMat(seedPoints) : new cv.Mat();
    const backward = seedPoints ? this.pointsMat(fromPoints) : new cv.Mat();
    const status = new cv.Mat(), errors = new cv.Mat(), backStatus = new cv.Mat(), backErrors = new cv.Mat();
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);
    const size = new cv.Size(21, 21);
    try {
      const flags = seedPoints ? (cv.OPTFLOW_USE_INITIAL_FLOW ?? 4) : 0;
      cv.calcOpticalFlowPyrLK(fromGray, toGray, before, after, status, errors, size, 3, criteria, flags, 0.0001);
      cv.calcOpticalFlowPyrLK(toGray, fromGray, after, backward, backStatus, backErrors, size, 3, criteria, flags, 0.0001);
      const survivors = [];
      for (let i = 0; i < fromPoints.length; ++i) {
        const point = { x: after.data32F[i * 2], y: after.data32F[i * 2 + 1] };
        const back = { x: backward.data32F[i * 2], y: backward.data32F[i * 2 + 1] };
        if (!status.data[i] || !backStatus.data[i] || !Number.isFinite(point.x + point.y + back.x + back.y)
          || point.x < 2 || point.y < 2 || point.x > this.width - 2 || point.y > this.height - 2
          || distance(fromPoints[i], back) > (seedPoints ? 1.1 : 1.5)
          || errors.data32F[i] > (seedPoints ? 24 : 32) || backErrors.data32F[i] > 32) continue;
        survivors.push({ index: i, point });
      }
      return survivors;
    } finally { deleteAll([before, after, backward, status, errors, backStatus, backErrors]); }
  }

  fit(referencePoints, currentPoints, referenceVerified = false, minPoints = MIN_POINTS) {
    if (currentPoints.length < minPoints) return null;
    const cv = this.cv, from = this.pointsMat(referencePoints), to = this.pointsMat(currentPoints), mask = new cv.Mat();
    let matrix;
    try {
      matrix = cv.findHomography(from, to, cv.RANSAC, referenceVerified ? 2.3 : 2.8, mask, 1000, 0.995);
      if (!matrix || matrix.empty()) return null;
      const homography = Array.from(matrix.data64F?.length ? matrix.data64F : matrix.data32F);
      if (Math.abs(homography[8]) > 1e-9) for (let i = 0; i < homography.length; ++i) homography[i] /= matrix.data64F?.length ? matrix.data64F[8] : matrix.data32F[8];
      const references = [], tracked = [];
      for (let i = 0; i < referencePoints.length; ++i) if (mask.data[i]) { references.push(referencePoints[i]); tracked.push(currentPoints[i]); }
      const inlierRatio = references.length / referencePoints.length;
      if (references.length < minPoints || inlierRatio < (referenceVerified ? 0.72 : 0.62)
        || spatialCoverage(references, this.box) < 0.16) return null;
      const geometry = validateHomography(homography, this.box, this.width, this.height, this.lastBox);
      if (!geometry) return null;
      const reprojection = references.reduce((sum, point, i) => {
        const projected = project(homography, point);
        return sum + (projected ? distance(projected, tracked[i]) : Infinity);
      }, 0) / references.length;
      if (reprojection > 1.8) return null;
      return { ...geometry, homography, featureCount: references.length, inlierRatio, referenceVerified,
        featureMethod: referenceVerified ? 'reference-lk' : 'optical-flow', references, tracked };
    } finally { deleteAll([from, to, mask, matrix]); }
  }

  referenceMatch(gray, nanoResult) {
    // Directly re-match the initial image near the last trusted location. This is
    // bounded local recovery, not an unlimited object detector or a new template.
    const projected = this.originalPoints.map(p => project(this.lastHomography, p));
    if (projected.some(p => !p)) return null;
    const adjustment = nanoResult?.reliable && plausibleStep(this.lastBox, nanoResult.box)
      ? boxTransform(this.lastBox, nanoResult.box) : IDENTITY;
    const seeds = projected.map(p => project(adjustment, p));
    if (seeds.some(p => !p)) return null;
    // Preserve the last measured orientation when reacquiring after occlusion.
    // Warping ORIGINAL pixels gives LK similar patch orientation without ever
    // replacing the original selection with pixels from an uncertain frame.
    const cv = this.cv, warped = new cv.Mat();
    const matrix = cv.matFromArray(3, 3, cv.CV_64FC1, this.lastHomography);
    try {
      cv.warpPerspective(this.referenceGray, warped, matrix, new cv.Size(this.width, this.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
      const survivors = this.flow(warped, gray, projected, seeds);
      const reference = survivors.map(p => this.originalPoints[p.index]);
      const current = survivors.map(p => p.point);
      const result = this.fit(reference, current, true);
      this.recordReferenceEvidence(result || this.fit(reference, current, true, 6));
      return result;
    } finally { deleteAll([warped, matrix]); }
  }

  recordReferenceEvidence(result) {
    if (!result) return;
    this.referenceEvidence = result.featureCount;
    this.lastReferenceEvidenceAt = performance.now();
  }

  commitGeometry(result) {
    if (!result?.reliable || !result.homography) return;
    this.trustedHomography = [...result.homography];
    this.trustedBox = { ...result.box };
  }

  rejectGeometry() {
    // Flow advances before fusion can compare it with appearance. A rejected
    // candidate must not become the seed for the next reference reacquisition.
    this.previousGray?.delete();
    this.previousGray = null;
    this.referencePoints = this.currentPoints = [];
    if (this.trustedHomography) this.lastHomography = [...this.trustedHomography];
    if (this.trustedBox) this.lastBox = { ...this.trustedBox };
    this.lastReferenceEvidenceAt = -Infinity;
    this.referenceEvidence = 0;
  }

  update(image, nanoResult, now = performance.now()) {
    if (!this.capable || !this.referenceGray) return this.failure('not-enough-features');
    if (image.width !== this.width || image.height !== this.height) throw new Error('The camera frame size changed. Select again.');
    const gray = this.gray(image);
    let result = null;
    try {
      if (this.previousGray && this.currentPoints.length >= MIN_POINTS) {
        const survivors = this.flow(this.previousGray, gray, this.currentPoints);
        result = this.fit(survivors.map(p => this.referencePoints[p.index]), survivors.map(p => p.point));
      }
      // Periodic direct verification arrests accumulated flow drift; when lost,
      // try at most four times per second to limit mobile CPU and false matches.
      if (now - this.lastReferenceAttempt >= (result ? 800 : 250)) {
        this.lastReferenceAttempt = now;
        const reference = this.referenceMatch(gray, nanoResult) || this.descriptorMatch(gray, nanoResult);
        if (reference) result = reference;
      }
      this.previousGray?.delete();
      this.previousGray = null;
      if (!result) { this.referencePoints = []; this.currentPoints = []; return this.failure('feature-confidence-low'); }
      this.previousGray = gray;
      this.referencePoints = result.references;
      this.currentPoints = result.tracked;
      this.lastHomography = result.homography;
      this.lastBox = result.box;
      return { reliable: true, ...result, referenceEvidence: performance.now() - this.lastReferenceEvidenceAt < 750 ? this.referenceEvidence : 0,
        references: undefined, tracked: undefined };
    } finally { if (this.previousGray !== gray) gray.delete(); }
  }

  reset() {
    deleteAll([this.referenceGray, this.previousGray, this.orb, this.matcher, this.descriptors]);
    this.referenceGray = this.previousGray = null;
    this.orb = this.matcher = this.descriptors = null;
    this.descriptorPoints = [];
    this.originalPoints = this.currentPoints = this.referencePoints = [];
    this.lastHomography = [...IDENTITY];
    this.trustedHomography = null;
    this.trustedBox = null;
    this.capable = false;
    this.lastReferenceAttempt = -Infinity;
    this.lastReferenceEvidenceAt = -Infinity;
    this.referenceEvidence = 0;
  }

  destroy() { this.reset(); }
}
