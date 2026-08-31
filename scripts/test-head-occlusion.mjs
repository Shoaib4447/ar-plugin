import assert from "node:assert/strict";
import {
  createHeadOccluderShape,
  headFrontDepthAt,
  isBehindHeadSurface,
} from "../src/head-occlusion.js";

const faceWidth = 0.3;
const shape = createHeadOccluderShape(faceWidth);
const frontCenter = headFrontDepthAt(0, shape.centerY, shape);

assert.ok(frontCenter < 0, "The invisible head must begin behind the bridge");
assert.ok(
  !isBehindHeadSurface({ x: 0, y: shape.centerY, z: 0.012 }, shape),
  "The front frame must remain visible",
);
assert.ok(
  isBehindHeadSurface({ x: 0, y: shape.centerY, z: -0.04 }, shape),
  "A far temple seen through an eye must be hidden",
);

const templeX = shape.radiusX * 0.72;
const templeSurface = headFrontDepthAt(templeX, shape.centerY, shape);
assert.ok(
  isBehindHeadSurface(
    { x: templeX, y: shape.centerY, z: templeSurface - 0.01 },
    shape,
  ),
  "A temple penetrating the side of the head must be hidden",
);
assert.ok(
  !isBehindHeadSurface(
    { x: templeX, y: shape.centerY, z: templeSurface + 0.01 },
    shape,
  ),
  "A temple in front of the skin surface must remain visible",
);
assert.equal(
  headFrontDepthAt(shape.radiusX * 1.01, shape.centerY, shape),
  null,
  "A temple outside the head silhouette must remain visible",
);

console.log("Head occlusion tests passed.");
