const THREE = window.THREE;
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 320;

function cardTexture(definition, renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  const context = canvas.getContext('2d');
  const inset = 4;
  const radius = 42;
  const right = TEXTURE_WIDTH - inset;
  const bottom = TEXTURE_HEIGHT - inset;
  context.beginPath();
  context.moveTo(inset + radius, inset);
  context.lineTo(right - radius, inset);
  context.quadraticCurveTo(right, inset, right, inset + radius);
  context.lineTo(right, bottom - radius);
  context.quadraticCurveTo(right, bottom, right - radius, bottom);
  context.lineTo(inset + radius, bottom);
  context.quadraticCurveTo(inset, bottom, inset, bottom - radius);
  context.lineTo(inset, inset + radius);
  context.quadraticCurveTo(inset, inset, inset + radius, inset);
  context.closePath();
  context.fillStyle = '#102320';
  context.fill();
  context.lineWidth = 6;
  context.strokeStyle = '#719e91';
  context.stroke();

  const writeText = (text, size, weight, color, y) => {
    const value = String(text ?? '');
    context.font = `${weight} ${size}px Arial, sans-serif`;
    while (size > 24 && context.measureText(value).width > TEXTURE_WIDTH - 128) {
      size -= 2;
      context.font = `${weight} ${size}px Arial, sans-serif`;
    }
    context.fillStyle = color;
    context.textBaseline = 'middle';
    context.fillText(value, 64, y, TEXTURE_WIDTH - 128);
  };
  writeText(definition.title, 118, 700, '#ffffff', 117);
  writeText(definition.detail, 86, 400, '#bdd4cb', 221);

  const texture = new THREE.CanvasTexture(canvas);
  texture.encoding = THREE.sRGBEncoding;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

// Keep each element in the model's coordinate system. No camera-facing updates.
export function createAnnotation(definition, bounds, renderer) {
  const group = new THREE.Group();
  group.name = `annotation-${definition.title}`;
  const anchor = new THREE.Object3D();
  anchor.position.copy(bounds.min).add(
    new THREE.Vector3(...definition.point).multiply(bounds.getSize(new THREE.Vector3())),
  );
  group.add(anchor);

  const card = new THREE.Group();
  card.name = 'annotation-card';
  card.position.copy(anchor.position).add(new THREE.Vector3(...definition.offset));
  card.rotation.set(...(definition.rotation || [0, 0, 0]));
  const width = definition.width || 0.44;
  const height = width * TEXTURE_HEIGHT / TEXTURE_WIDTH;
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({
    map: cardTexture(definition, renderer),
    side: THREE.FrontSide,
    transparent: true,
    alphaTest: 0.05,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  const front = new THREE.Mesh(geometry, material);
  front.name = 'annotation-front';
  front.position.z = 0.0002;
  const back = new THREE.Mesh(geometry, material);
  back.name = 'annotation-back';
  back.position.z = -0.0002;
  back.rotation.y = Math.PI;
  card.add(front, back);
  group.add(card);

  // Find the nearest rectangle edge in card-local space, including card rotation.
  const edge = anchor.position.clone().sub(card.position)
    .applyQuaternion(card.quaternion.clone().invert());
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const inside = Math.abs(edge.x) <= halfWidth && Math.abs(edge.y) <= halfHeight;
  edge.x = THREE.MathUtils.clamp(edge.x, -halfWidth, halfWidth);
  edge.y = THREE.MathUtils.clamp(edge.y, -halfHeight, halfHeight);
  if (inside) {
    if (halfWidth - Math.abs(edge.x) < halfHeight - Math.abs(edge.y)) {
      edge.x = edge.x < 0 ? -halfWidth : halfWidth;
    } else {
      edge.y = edge.y < 0 ? -halfHeight : halfHeight;
    }
  }
  edge.z = 0;
  edge.applyQuaternion(card.quaternion).add(card.position);
  const direction = edge.clone().sub(anchor.position);
  const length = direction.length();
  const leaderMaterial = new THREE.MeshBasicMaterial({
    color: 0xb5e5d2, depthTest: true, toneMapped: false,
  });
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.0015, 0.0015, Math.max(length, 0.00001), 8),
    leaderMaterial,
  );
  line.name = 'annotation-leader';
  line.position.copy(anchor.position).add(edge).multiplyScalar(0.5);
  if (length > 0) line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  line.visible = length > 0;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.005, 12, 8), leaderMaterial);
  dot.name = 'annotation-anchor';
  dot.position.copy(anchor.position);
  group.add(line, dot);
  return { group, card, front, back, anchor, line, dot };
}
