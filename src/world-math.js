// Column-major matrices, matching XRRigidTransform and Three.js. No browser globals.
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function finiteMatrix(matrix) {
  return matrix?.length === 16 && Array.from(matrix).every(Number.isFinite);
}

export function rigidMatrix(matrix) {
  if (!finiteMatrix(matrix)) return false;
  if (Math.abs(matrix[3]) + Math.abs(matrix[7]) + Math.abs(matrix[11]) + Math.abs(matrix[15] - 1) > 0.001) return false;
  const a = [matrix[0], matrix[1], matrix[2]];
  const b = [matrix[4], matrix[5], matrix[6]];
  const c = [matrix[8], matrix[9], matrix[10]];
  const dot = (u, v) => u.reduce((sum, n, i) => sum + n * v[i], 0);
  const determinant = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  return [dot(a, a) - 1, dot(b, b) - 1, dot(c, c) - 1, dot(a, b), dot(a, c), dot(b, c), determinant - 1].every(n => Math.abs(n) < 0.01);
}

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

export function inverseRigid(matrix) {
  const out = identity();
  for (let column = 0; column < 3; column++) {
    for (let row = 0; row < 3; row++) out[column * 4 + row] = matrix[row * 4 + column];
  }
  for (let row = 0; row < 3; row++) out[12 + row] = -(out[row] * matrix[12] + out[4 + row] * matrix[13] + out[8 + row] * matrix[14]);
  return out;
}

export function inverseMatrix(matrix) {
  if (!finiteMatrix(matrix)) return null;
  const rows = Array.from({ length: 4 }, (_, r) => Array.from({ length: 8 }, (_, c) => c < 4 ? matrix[c * 4 + r] : Number(c - 4 === r)));
  for (let column = 0; column < 4; column++) {
    let pivot = column;
    for (let row = column + 1; row < 4; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    rows[column] = rows[column].map(n => n / divisor);
    for (let row = 0; row < 4; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      rows[row] = rows[row].map((n, i) => n - factor * rows[column][i]);
    }
  }
  return Array.from({ length: 16 }, (_, i) => rows[i % 4][4 + Math.floor(i / 4)]);
}

function transform(matrix, vector) {
  return Array.from({ length: 4 }, (_, row) => vector.reduce((sum, n, column) => sum + n * matrix[column * 4 + row], 0));
}

export function selectionRay(point, projection, viewToViewer = identity()) {
  const inverse = inverseMatrix(projection);
  if (!inverse || !rigidMatrix(viewToViewer) || !Number.isFinite(point?.x) || !Number.isFinite(point?.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const near = transform(inverse, [point.x * 2 - 1, 1 - point.y * 2, -1, 1]);
  if (Math.abs(near[3]) < 1e-9) return null;
  const direction = transform(viewToViewer, [near[0] / near[3], near[1] / near[3], near[2] / near[3], 0]);
  const length = Math.hypot(...direction.slice(0, 3));
  if (!(length > 0)) return null;
  return {
    origin: { x: viewToViewer[12], y: viewToViewer[13], z: viewToViewer[14], w: 1 },
    direction: { x: direction[0] / length, y: direction[1] / length, z: direction[2] / length, w: 0 }
  };
}

export const translationDistance = (a, b) => Math.hypot(a[12] - b[12], a[13] - b[13], a[14] - b[14]);
export const normalDot = (a, b) => a[4] * b[4] + a[5] * b[5] + a[6] * b[6];

// Face the initial viewer once. This transform is never recomputed during camera motion.
export function placementMatrix(hit, viewer, { offsetRight = 0.30, offsetUp = 0.015 } = {}) {
  let zX = viewer[12] - hit[12];
  let zZ = viewer[14] - hit[14];
  if (Math.hypot(zX, zZ) < 1e-6) { zX = viewer[8]; zZ = viewer[10]; }
  const length = Math.hypot(zX, zZ);
  if (length < 1e-6) { zX = 0; zZ = 1; } else { zX /= length; zZ /= length; }
  const rightX = zZ;
  const rightZ = -zX;
  return [rightX, 0, rightZ, 0, 0, 1, 0, 0, zX, 0, zZ, 0,
    hit[12] + rightX * offsetRight, hit[13] + offsetUp, hit[14] + rightZ * offsetRight, 1];
}

export function quaternionFromMatrix(m) {
  const trace = m[0] + m[5] + m[10];
  let x, y, z, w;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    w = s / 4; x = (m[6] - m[9]) / s; y = (m[8] - m[2]) / s; z = (m[1] - m[4]) / s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[5] - m[10]);
    w = (m[6] - m[9]) / s; x = s / 4; y = (m[4] + m[1]) / s; z = (m[8] + m[2]) / s;
  } else if (m[5] > m[10]) {
    const s = 2 * Math.sqrt(1 + m[5] - m[0] - m[10]);
    w = (m[8] - m[2]) / s; x = (m[4] + m[1]) / s; y = s / 4; z = (m[9] + m[6]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[10] - m[0] - m[5]);
    w = (m[1] - m[4]) / s; x = (m[8] + m[2]) / s; y = (m[9] + m[6]) / s; z = s / 4;
  }
  return { x, y, z, w };
}
