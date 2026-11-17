export const MAX_VIEWPORT_EDGE = 4096;
export const MAX_VIEWPORT_PIXELS = 8_388_608;

/**
 * Fit CSS pixels inside the capture budget without rounding above its limits.
 * @param {{width: number, height: number}} rect Measured panel content box.
 * @param {boolean} visible Whether the host document is visible.
 * @returns {{visible: false} | {visible: true, width: number, height: number}}
 */
export function panelViewport(rect, visible) {
  if (!visible || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return { visible: false };
  const scale = Math.min(1, MAX_VIEWPORT_EDGE / rect.width, MAX_VIEWPORT_EDGE / rect.height, Math.sqrt(MAX_VIEWPORT_PIXELS / (rect.width * rect.height)));
  return { visible: true, width: Math.max(1, Math.floor(rect.width * scale)), height: Math.max(1, Math.floor(rect.height * scale)) };
}

/** Map a pointer in an object-fit:contain image to normalized renderer coordinates. */
export function imagePoint(rect, image, clientX, clientY) {
  if (!rect.width || !rect.height || !image.width || !image.height) return null;
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
