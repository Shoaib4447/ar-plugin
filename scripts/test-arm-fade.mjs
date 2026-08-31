import assert from "node:assert/strict";
import {
  armEndOpacityAt,
  createArmFadeRange,
  patchLegacyEyewearShader,
} from "../src/arm-fade.js";

const range = createArmFadeRange(-1, 0);
assert.equal(armEndOpacityAt(-1, range), 0);
assert.equal(armEndOpacityAt(range.invisibleZ, range), 0);
assert.ok(armEndOpacityAt(-0.9, range) > 0);
assert.ok(armEndOpacityAt(-0.9, range) < 1);
assert.equal(armEndOpacityAt(range.opaqueZ, range), 1);
assert.equal(armEndOpacityAt(0, range), 1);
assert.equal(createArmFadeRange(0, 0), null);

const shader = {
  uniforms: {},
  vertexShader: "#include <common>\n#include <begin_vertex>",
  fragmentShader:
    "#include <common>\n#include <map_fragment>\n#include <alphatest_fragment>",
};
patchLegacyEyewearShader(shader, range, true);
assert.match(shader.vertexShader, /vFrameLabArmEndOpacity = smoothstep/);
assert.match(shader.fragmentShader, /diffuseColor\.a \*= vFrameLabArmEndOpacity/);
assert.match(shader.fragmentShader, /legacyLensMask/);
assert.equal(shader.uniforms.frameLabArmFadeInvisibleZ.value, range.invisibleZ);

console.log("Arm fade tests passed.");
