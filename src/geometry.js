// Camera and frozen selection image both use centered object-fit: cover.
// Tracker coordinates stay in the unmirrored, downsampled camera frame.
export function coverTransform(frameWidth, frameHeight, viewWidth, viewHeight) {
  const scale = Math.max(viewWidth / frameWidth, viewHeight / frameHeight);
  return { scale, offsetX: (viewWidth - frameWidth * scale) / 2, offsetY: (viewHeight - frameHeight * scale) / 2 };
}
export function frameRectToView(rect, t) {
  return { x: rect.x * t.scale + t.offsetX, y: rect.y * t.scale + t.offsetY, width: rect.width * t.scale, height: rect.height * t.scale };
}
export function viewRectToFrame(rect, t, width, height) {
  const x = Math.max(0, (rect.x - t.offsetX) / t.scale);
  const y = Math.max(0, (rect.y - t.offsetY) / t.scale);
  const right = Math.min(width, (rect.x + rect.width - t.offsetX) / t.scale);
  const bottom = Math.min(height, (rect.y + rect.height - t.offsetY) / t.scale);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
export function processingSize(width, height, maximum) {
  const ratio = Math.min(1, maximum / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
export function isValidBox(box, width, height) {
  return box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 1 && box.height > 1 && box.width <= width * 1.1 && box.height <= height * 1.1
    && box.x + box.width > 0 && box.y + box.height > 0 && box.x < width && box.y < height;
}
