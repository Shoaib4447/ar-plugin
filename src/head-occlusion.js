export const HEAD_OCCLUSION_PROFILE = Object.freeze({
  // MediaPipe's side-face landmarks approximate the skin boundary at eye level.
  // A small expansion covers the temple/ear transition without hiding hinges
  // that sit outside a correctly sized frame.
  radiusXToFaceWidth: 0.515,
  radiusYToFaceWidth: 0.7,
  radiusZToFaceWidth: 0.63,
  centerYToFaceWidth: -0.1,
  frontInset: 0.008,
});

export function createHeadOccluderShape(
  faceWidth,
  profile = HEAD_OCCLUSION_PROFILE,
) {
  const safeWidth = Number.isFinite(faceWidth) ? Math.max(faceWidth, 0) : 0;
  const radiusX = safeWidth * profile.radiusXToFaceWidth;
  const radiusY = safeWidth * profile.radiusYToFaceWidth;
  const radiusZ = safeWidth * profile.radiusZToFaceWidth;

  return {
    radiusX,
    radiusY,
    radiusZ,
    centerY: safeWidth * profile.centerYToFaceWidth,
    // The front of the invisible head remains behind the eyewear bridge. The
    // ellipsoid then extends through the temples and toward the back of head.
    centerZ: -radiusZ - profile.frontInset,
  };
}

// These helpers document and regression-test the same ellipsoid used by Three.js.
// Coordinates are local to the bridge before the tracked head rotation is applied.
export function headFrontDepthAt(x, y, shape) {
  if (!shape || shape.radiusX <= 0 || shape.radiusY <= 0 || shape.radiusZ <= 0) {
    return null;
  }

  const normalizedX = x / shape.radiusX;
  const normalizedY = (y - shape.centerY) / shape.radiusY;
  const radialSquared = normalizedX ** 2 + normalizedY ** 2;
  if (radialSquared >= 1) return null;

  return shape.centerZ + shape.radiusZ * Math.sqrt(1 - radialSquared);
}

export function isBehindHeadSurface({ x, y, z }, shape) {
  const frontDepth = headFrontDepthAt(x, y, shape);
  return frontDepth !== null && z < frontDepth;
}
