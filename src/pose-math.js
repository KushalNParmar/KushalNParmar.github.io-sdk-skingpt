// A homography describes image geometry, not the metric pose of an arbitrary
// 3D object. Only its locally measured screen-plane rotation is used here.
export function measuredScreenRoll(result) {
  const h = result?.homography;
  const reference = result?.referenceBox;
  if (!result?.reliable || !h || h.length !== 9 || !Array.from(h).every(Number.isFinite)
    || !reference || ![reference.x, reference.y, reference.width, reference.height].every(Number.isFinite)
    || reference.width <= 0 || reference.height <= 0
    || result.featureCount < 8 || result.inlierRatio < 0.55
    || !Number.isFinite(result.featureCount) || !Number.isFinite(result.inlierRatio)) return null;

  const x = reference.x + reference.width / 2;
  const y = reference.y + reference.height / 2;
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-7) return null;
  const u = (h[0] * x + h[1] * y + h[2]) / w;
  const v = (h[3] * x + h[4] * y + h[5]) / w;
  const a = (h[0] - u * h[6]) / w;
  const b = (h[1] - u * h[7]) / w;
  const c = (h[3] - v * h[6]) / w;
  const d = (h[4] - v * h[7]) / w;
  const determinant = a * d - b * c;
  const frobeniusSquared = a * a + b * b + c * c + d * d;
  if (![a, b, c, d, determinant, frobeniusSquared].every(Number.isFinite)
    || determinant <= 1e-5) return null;

  // Reject near-collapsed/edge-on geometry. The ratio is sigmaMax/sigmaMin
  // plus its reciprocal, so 6.17 corresponds to about a 6:1 anisotropy limit.
  if (frobeniusSquared / determinant > 6.17) return null;
  // The proper polar rotation removes symmetric stretch from the Jacobian.
  // Image y points down; Three's screen-plane y points up.
  return -Math.atan2(c - b, a + d);
}

export function unwrapAngle(angle, previous) {
  return previous + Math.atan2(Math.sin(angle - previous), Math.cos(angle - previous));
}

export function rotatedExtent(width, height, angle) {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  return { width: width * c + height * s, height: width * s + height * c };
}
