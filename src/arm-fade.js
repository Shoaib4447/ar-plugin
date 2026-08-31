export const ARM_END_FADE_PROFILE = Object.freeze({
  invisibleThroughFraction: 0.02,
  opaqueAtFraction: 0.18,
});

export function createArmFadeRange(
  backZ,
  frontZ,
  profile = ARM_END_FADE_PROFILE,
) {
  const depth = frontZ - backZ;
  if (!Number.isFinite(depth) || depth <= 0) return null;

  return {
    invisibleZ: backZ + depth * profile.invisibleThroughFraction,
    opaqueZ: backZ + depth * profile.opaqueAtFraction,
  };
}

export function armEndOpacityAt(z, range) {
  if (!range || z <= range.invisibleZ) return 0;
  if (z >= range.opaqueZ) return 1;
  const value = (z - range.invisibleZ) / (range.opaqueZ - range.invisibleZ);
  return value * value * (3 - 2 * value);
}

export function patchLegacyEyewearShader(shader, range, applyLensFallback) {
  shader.uniforms.frameLabArmFadeInvisibleZ = { value: range.invisibleZ };
  shader.uniforms.frameLabArmFadeOpaqueZ = { value: range.opaqueZ };

  shader.vertexShader = shader.vertexShader
    .replace(
      "#include <common>",
      `#include <common>
       uniform float frameLabArmFadeInvisibleZ;
       uniform float frameLabArmFadeOpaqueZ;
       varying float vFrameLabArmEndOpacity;`,
    )
    .replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
       vFrameLabArmEndOpacity = smoothstep(
         frameLabArmFadeInvisibleZ,
         frameLabArmFadeOpaqueZ,
         position.z
       );`,
    );

  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      `#include <common>
       varying float vFrameLabArmEndOpacity;`,
    )
    .replace(
      "#include <alphatest_fragment>",
      `diffuseColor.a *= vFrameLabArmEndOpacity;
       #include <alphatest_fragment>`,
    );

  if (applyLensFallback) {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#include <map_fragment>
       float legacyBrightness = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
       float legacyLensMask = smoothstep(0.62, 0.9, legacyBrightness);
       diffuseColor.a *= mix(1.0, 0.22, legacyLensMask);`,
    );
  }
}
