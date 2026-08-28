import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const FIT_STORAGE_KEY = "ar-glasses-v0-fit-v4";

const LANDMARK = {
  LEFT_EYE_OUTER: 33,
  RIGHT_EYE_OUTER: 263,
  NOSE_BRIDGE: 168,
  NOSE_MID: 6,
  LEFT_TEMPLE: 234,
  RIGHT_TEMPLE: 454,
};

function loadFit() {
  try {
    return {
      size: 1,
      height: 0,
      armDepth: 1.85,
      noseDepth: 0.09,
      ...JSON.parse(localStorage.getItem(FIT_STORAGE_KEY)),
    };
  } catch {
    return { size: 1, height: 0, armDepth: 1.85, noseDepth: 0.09 };
  }
}

export class TryOnSession {
  constructor({
    video,
    canvas,
    hint,
    sizeControl,
    heightControl,
    armControl,
    noseDepthControl,
  }) {
    this.video = video;
    this.canvas = canvas;
    this.hint = hint;
    this.sizeControl = sizeControl;
    this.heightControl = heightControl;
    this.armControl = armControl;
    this.noseDepthControl = noseDepthControl;
    this.fit = loadFit();
    this.sizeControl.value = String(this.fit.size);
    this.heightControl.value = String(this.fit.height);
    this.armControl.value = String(this.fit.armDepth);
    this.noseDepthControl.value = String(this.fit.noseDepth);

    this.clock = new THREE.Clock();
    this.targetPosition = new THREE.Vector3();
    this.targetScale = new THREE.Vector3(1, 1, 1);
    this.targetQuaternion = new THREE.Quaternion();
    this.smoothedContact = new THREE.Vector2();
    this.bridgeAnchorLocal = new THREE.Vector3();
    this.frontBridgeOffset = new THREE.Vector3();
    this.rotatedBridgeOffset = new THREE.Vector3();
    this.poseMatrix = new THREE.Matrix4();
    this.posePosition = new THREE.Vector3();
    this.poseScale = new THREE.Vector3();
    this.lastVideoTime = -1;
    this.lastSeenAt = 0;
    this.running = false;

    this.onFitInput = () => {
      this.fit = {
        size: Number(this.sizeControl.value),
        height: Number(this.heightControl.value),
        armDepth: Number(this.armControl.value),
        noseDepth: Number(this.noseDepthControl.value),
      };
      localStorage.setItem(FIT_STORAGE_KEY, JSON.stringify(this.fit));
      this.applyModelShape();
    };
    this.sizeControl.addEventListener("input", this.onFitInput);
    this.heightControl.addEventListener("input", this.onFitInput);
    this.armControl.addEventListener("input", this.onFitInput);
    this.noseDepthControl.addEventListener("input", this.onFitInput);
  }

  async start(glbUrl) {
    if (this.running) return;
    this.running = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      await Promise.all([this.initTracker(), this.initRenderer(glbUrl)]);
      this.resize();
      window.addEventListener("resize", this.resizeBound);
      this.loop();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  async initTracker() {
    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = {
      baseOptions: {
        modelAssetPath: FACE_MODEL_URL,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.55,
      minFacePresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    };

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, options);
    } catch (gpuError) {
      console.warn("GPU face tracking unavailable; using CPU.", gpuError);
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: FACE_MODEL_URL },
      });
    }
  }

  async initRenderer(glbUrl) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    // The image plane is one scene-unit tall at z=0. A perspective camera is
    // important here: it makes the temple arms recede naturally toward the ears.
    const verticalFov = 50;
    this.camera = new THREE.PerspectiveCamera(verticalFov, 1, 0.01, 20);
    const cameraDistance = 0.5 / Math.tan(THREE.MathUtils.degToRad(verticalFov / 2));
    this.cameraDistance = cameraDistance;
    this.camera.position.set(0, 0, cameraDistance);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5b6470, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-2, 3, 4);
    this.scene.add(key);

    this.glasses = new THREE.Group();

    // A small depth-only ellipsoid approximates the face. It lets the frame stay
    // visible while hiding temple geometry that passes behind the head on turns.
    const occluderMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });
    this.occluder = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 32, 20),
      occluderMaterial,
    );
    this.occluder.scale.set(1.58, 1.62, 2.16);
    this.occluder.position.set(0, 0.01, -1.06);
    this.occluder.renderOrder = -100;
    this.glasses.add(this.occluder);

    this.glasses.visible = false;
    this.scene.add(this.glasses);
    await this.switchModel(glbUrl);

    this.resizeBound = () => this.resize();
  }

  async switchModel(glbUrl) {
    if (this.activeModelUrl === glbUrl && this.model) return true;

    const loadId = (this.modelLoadId || 0) + 1;
    this.modelLoadId = loadId;
    if (this.model) {
      // Release the 50+ MB decoded model before parsing the next one. Keeping
      // both Meshy exports alive at once can exhaust the browser's graphics
      // memory and leave the old frame on screen even though the select changed.
      this.glasses.visible = false;
      this.glasses.remove(this.model);
      this.disposeObject(this.model);
      this.renderer?.renderLists?.dispose();
      this.model = null;
      this.armOverlays = { negativeX: [], positiveX: [] };
      this.frameOverlays = [];
      this.activeModelUrl = null;
    }

    const gltf = await new GLTFLoader().loadAsync(glbUrl);
    if (loadId !== this.modelLoadId || !this.glasses) {
      this.disposeObject(gltf.scene);
      return false;
    }

    const nextModel = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(nextModel);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (!Number.isFinite(size.x) || size.x <= 0 || size.z <= 0) {
      this.disposeObject(nextModel);
      throw new Error("The selected GLB has invalid dimensions.");
    }

    this.model = nextModel;
    this.modelBaseScale = 1 / size.x;
    this.modelWidth = size.x;
    this.modelCenter = center;
    this.modelFrontZ = bounds.max.z;
    this.modelDepth = size.z;
    this.modelBridgePoint = this.findModelBridgePoint();
    this.applyModelShape();

    const sourceMeshes = [];
    this.model.traverse((node) => {
      if (!node.isMesh) return;
      sourceMeshes.push(node);
      node.castShadow = false;
      node.frustumCulled = false;
      node.renderOrder = 1;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => this.improveLensTransparency(material));
    });

    // Each fused model gets the same front-frame and near-arm occlusion layers.
    this.armOverlays = { negativeX: [], positiveX: [] };
    this.frameOverlays = [];
    sourceMeshes.forEach((mesh) => this.createArmOverlays(mesh));
    this.glasses.add(this.model);
    this.updateOccluderShape();
    this.glasses.visible = false;
    this.activeModelUrl = glbUrl;
    return true;
  }

  disposeObject(object) {
    if (!object) return;
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    object.traverse((node) => {
      if (!node.isMesh) return;
      if (node.geometry) geometries.add(node.geometry);
      const nodeMaterials = Array.isArray(node.material)
        ? node.material
        : [node.material];
      nodeMaterials.forEach((material) => {
        if (!material) return;
        materials.add(material);
        Object.values(material).forEach((value) => {
          if (value?.isTexture) textures.add(value);
        });
      });
    });
    textures.forEach((texture) => {
      texture.dispose();
      // GLTFLoader commonly decodes embedded textures as ImageBitmap objects.
      // Three.js cannot release their CPU-side pixel memory through dispose().
      texture.source?.data?.close?.();
    });
    materials.forEach((material) => material.dispose());
    geometries.forEach((geometry) => geometry.dispose());
  }

  findModelBridgePoint() {
    const bridgeSum = new THREE.Vector3();
    let bridgeVertexCount = 0;
    const centerStrip = this.modelWidth * 0.02;

    this.model.traverse((node) => {
      if (!node.isMesh) return;
      const position = node.geometry?.getAttribute("position");
      if (!position) return;
      for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const z = position.getZ(index);
        const depthFromFrame = (this.modelFrontZ - z) / this.modelDepth;
        if (
          Math.abs(x - this.modelCenter.x) <= centerStrip &&
          depthFromFrame <= 0.25
        ) {
          bridgeSum.x += x;
          bridgeSum.y += position.getY(index);
          bridgeSum.z += z;
          bridgeVertexCount += 1;
        }
      }
    });

    if (!bridgeVertexCount) {
      return new THREE.Vector3(
        this.modelCenter.x,
        this.modelCenter.y,
        this.modelFrontZ,
      );
    }
    return bridgeSum.multiplyScalar(1 / bridgeVertexCount);
  }

  createArmOverlays(sourceMesh) {
    const sourceGeometry = sourceMesh.geometry;
    const position = sourceGeometry?.getAttribute("position");
    const sourceIndex = sourceGeometry?.index?.array;
    if (!position || !sourceIndex || this.modelDepth <= 0) return;

    let negativeCount = 0;
    let positiveCount = 0;
    let frameCount = 0;

    // The frame lives at max Z; its arms run toward min Z. Keeping only the
    // middle 72% removes the front rims and the hook that belongs behind an ear.
    const classifyTriangle = (offset) => {
      const a = sourceIndex[offset];
      const b = sourceIndex[offset + 1];
      const c = sourceIndex[offset + 2];
      const centerZ = (position.getZ(a) + position.getZ(b) + position.getZ(c)) / 3;
      const depthFromFrame = (this.modelFrontZ - centerZ) / this.modelDepth;
      const centerX = (position.getX(a) + position.getX(b) + position.getX(c)) / 3;

      // Protect the outermost front surface plus the deeper central bridge.
      // Limiting the deeper selection to the model center keeps the arms out.
      const centeredX = Math.abs(centerX - this.modelCenter.x) / this.modelWidth;
      const isFrontFrame =
        depthFromFrame <= 0.075 ||
        (centeredX < 0.3 && depthFromFrame <= 0.22);
      let classification = isFrontFrame ? 1 : 0;
      if (depthFromFrame >= 0.08 && depthFromFrame <= 0.68) {
        classification |= centerX < this.modelCenter.x ? 2 : 4;
      }
      return classification;
    };

    // Count first, then allocate exactly what each overlay needs. Both GLBs
    // contain more than four million indices, so three maximum-size buffers
    // plus their sliced copies can exhaust a mobile WebGL context.
    const triangleClassifications = new Uint8Array(sourceIndex.length / 3);
    for (let offset = 0, triangle = 0; offset < sourceIndex.length; offset += 3, triangle += 1) {
      const classification = classifyTriangle(offset);
      triangleClassifications[triangle] = classification;
      if (classification & 1) frameCount += 3;
      if (classification & 2) negativeCount += 3;
      if (classification & 4) positiveCount += 3;
    }

    const IndexArray = sourceIndex.constructor;
    const negativeIndices = new IndexArray(negativeCount);
    const positiveIndices = new IndexArray(positiveCount);
    const frameIndices = new IndexArray(frameCount);
    let negativeOffset = 0;
    let positiveOffset = 0;
    let frameOffset = 0;

    for (let offset = 0, triangle = 0; offset < sourceIndex.length; offset += 3, triangle += 1) {
      const classification = triangleClassifications[triangle];
      const a = sourceIndex[offset];
      const b = sourceIndex[offset + 1];
      const c = sourceIndex[offset + 2];
      if (classification & 1) {
        frameIndices[frameOffset] = a;
        frameIndices[frameOffset + 1] = b;
        frameIndices[frameOffset + 2] = c;
        frameOffset += 3;
      }
      if (classification & 2) {
        negativeIndices[negativeOffset] = a;
        negativeIndices[negativeOffset + 1] = b;
        negativeIndices[negativeOffset + 2] = c;
        negativeOffset += 3;
      }
      if (classification & 4) {
        positiveIndices[positiveOffset] = a;
        positiveIndices[positiveOffset + 1] = b;
        positiveIndices[positiveOffset + 2] = c;
        positiveOffset += 3;
      }
    }

    const addOverlay = (side, indexBuffer, indexCount, isFrame = false) => {
      if (!indexCount) return;
      const geometry = new THREE.BufferGeometry();
      Object.entries(sourceGeometry.attributes).forEach(([name, attribute]) => {
        geometry.setAttribute(name, attribute);
      });
      geometry.setIndex(new THREE.BufferAttribute(indexBuffer, 1));

      const sourceMaterials = Array.isArray(sourceMesh.material)
        ? sourceMesh.material
        : [sourceMesh.material];
      const materials = sourceMaterials.map((sourceMaterial) => {
        const material = sourceMaterial.clone();
        material.transparent = true;
        material.opacity = isFrame ? 1 : 0;
        material.depthTest = false;
        material.depthWrite = false;
        if (isFrame) this.makeFrameOverlayMaterial(material);
        material.needsUpdate = true;
        return material;
      });
      const overlay = new THREE.Mesh(
        geometry,
        Array.isArray(sourceMesh.material) ? materials : materials[0],
      );
      overlay.name = isFrame ? "protected-front-frame" : `near-arm-${side}`;
      overlay.position.copy(sourceMesh.position);
      overlay.quaternion.copy(sourceMesh.quaternion);
      overlay.scale.copy(sourceMesh.scale);
      overlay.matrix.copy(sourceMesh.matrix);
      overlay.matrixAutoUpdate = sourceMesh.matrixAutoUpdate;
      overlay.frustumCulled = false;
      overlay.renderOrder = isFrame ? 4 : 3;
      overlay.visible = isFrame;
      sourceMesh.parent.add(overlay);
      if (isFrame) this.frameOverlays.push(overlay);
      else this.armOverlays[side].push(overlay);
    };

    addOverlay("negativeX", negativeIndices, negativeCount);
    addOverlay("positiveX", positiveIndices, positiveCount);
    addOverlay("frame", frameIndices, frameCount, true);
  }

  makeFrameOverlayMaterial(material) {
    if (!material?.map) return;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float arFrameBrightness = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         float arFrameMask = 1.0 - smoothstep(0.38, 0.72, arFrameBrightness);
         diffuseColor.a *= arFrameMask;
         if (diffuseColor.a < 0.025) discard;`,
      );
    };
    material.customProgramCacheKey = () => "ar-dark-front-frame-v1";
  }

  updateArmOcclusion(landmarks, faceYaw) {
    if (!this.armOverlays) return;
    const templeA = landmarks[LANDMARK.LEFT_TEMPLE];
    const templeB = landmarks[LANDMARK.RIGHT_TEMPLE];
    const depthDifference = templeA.z - templeB.z;
    const depthStrength = THREE.MathUtils.clamp(
      (Math.abs(depthDifference) - 0.006) / 0.045,
      0,
      1,
    );
    const yawStrength = THREE.MathUtils.smoothstep(Math.abs(faceYaw), 0.08, 0.28);
    const strength = depthStrength * yawStrength;
    const nearerTemple = depthDifference < 0 ? templeA : templeB;
    const otherTemple = depthDifference < 0 ? templeB : templeA;
    const nearSide = nearerTemple.x < otherTemple.x ? "negativeX" : "positiveX";

    Object.entries(this.armOverlays).forEach(([side, overlays]) => {
      const opacity = side === nearSide ? strength : 0;
      overlays.forEach((overlay) => {
        overlay.visible = opacity > 0.015;
        const materials = Array.isArray(overlay.material)
          ? overlay.material
          : [overlay.material];
        materials.forEach((material) => {
          material.opacity = opacity;
        });
      });
    });
  }

  applyModelShape() {
    if (!this.model || !this.modelCenter || !this.modelBaseScale) return;
    const depthScale = this.modelBaseScale * this.fit.armDepth;
    const noseAnchorZ = this.modelFrontZ - this.modelDepth * this.fit.noseDepth;
    this.model.scale.set(this.modelBaseScale, this.modelBaseScale, depthScale);

    // Put the front plane of the frame at the group origin. Head rotation now
    // happens around the bridge/frame instead of halfway down the temple arms.
    this.model.position.set(
      -this.modelCenter.x * this.modelBaseScale,
      -this.modelCenter.y * this.modelBaseScale,
      -noseAnchorZ * depthScale,
    );
    this.frameFrontOffset = this.modelDepth * this.fit.noseDepth * depthScale;
    if (this.modelBridgePoint) {
      this.bridgeAnchorLocal.set(
        (this.modelBridgePoint.x - this.modelCenter.x) * this.modelBaseScale,
        (this.modelBridgePoint.y - this.modelCenter.y) * this.modelBaseScale,
        (this.modelBridgePoint.z - noseAnchorZ) * depthScale,
      );
    }
    this.updateOccluderShape();
  }

  updateOccluderShape() {
    if (!this.occluder || !this.modelDepth || !this.modelBaseScale) return;
    const stretchedDepth =
      this.modelDepth * this.modelBaseScale * this.fit.armDepth;

    // Start near the frame plane so the far arm cannot project through the
    // opposite lens. The protected dark-frame overlay restores the bridge/rims.
    const occluderFront = Math.min(
      0.02,
      this.frameFrontOffset - stretchedDepth * 0.04,
    );
    const occluderBack = -stretchedDepth * 1.1;
    const occluderCenter = (occluderFront + occluderBack) / 2;
    const occluderDepth = occluderFront - occluderBack;
    this.occluder.scale.set(1.58, 1.62, occluderDepth);
    this.occluder.position.set(0, 0.01, occluderCenter);
  }

  improveLensTransparency(material) {
    if (!material?.map) return;
    material.transparent = true;
    material.depthWrite = true;
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
         float arBrightness = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
         float arLensMask = smoothstep(0.58, 0.88, arBrightness);
         diffuseColor.a *= mix(1.0, 0.2, arLensMask);`,
      );
    };
    material.customProgramCacheKey = () => "ar-light-lens-transparency-v2";
    material.needsUpdate = true;
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const aspect = width / height;
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  mapLandmark(point) {
    const videoWidth = this.video.videoWidth || 1280;
    const videoHeight = this.video.videoHeight || 720;
    const viewWidth = this.canvas.clientWidth || window.innerWidth;
    const viewHeight = this.canvas.clientHeight || window.innerHeight;
    const coverScale = Math.max(viewWidth / videoWidth, viewHeight / videoHeight);
    const shownWidth = videoWidth * coverScale;
    const shownHeight = videoHeight * coverScale;
    const cropX = (shownWidth - viewWidth) / 2;
    const cropY = (shownHeight - viewHeight) / 2;
    const screenX = (point.x * shownWidth - cropX) / viewWidth;
    const screenY = (point.y * shownHeight - cropY) / viewHeight;
    return new THREE.Vector2(
      (screenX - 0.5) * this.aspect,
      0.5 - screenY,
    );
  }

  updatePose(result, now) {
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks) return;

    const leftEye = this.mapLandmark(landmarks[LANDMARK.LEFT_EYE_OUTER]);
    const rightEye = this.mapLandmark(landmarks[LANDMARK.RIGHT_EYE_OUTER]);
    const bridge = this.mapLandmark(landmarks[LANDMARK.NOSE_BRIDGE]);
    const noseMid = this.mapLandmark(landmarks[LANDMARK.NOSE_MID]);
    const leftTemple = this.mapLandmark(landmarks[LANDMARK.LEFT_TEMPLE]);
    const rightTemple = this.mapLandmark(landmarks[LANDMARK.RIGHT_TEMPLE]);
    const eyeSpan = leftEye.distanceTo(rightEye);
    const templeSpan = leftTemple.distanceTo(rightTemple);
    if (eyeSpan < 0.02 || templeSpan < 0.04) return;

    const matrixData = result.facialTransformationMatrixes?.[0]?.data;
    if (matrixData?.length === 16) {
      this.poseMatrix.fromArray(matrixData);
      this.poseMatrix.decompose(this.posePosition, this.targetQuaternion, this.poseScale);
    } else {
      const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
      this.targetQuaternion.setFromEuler(new THREE.Euler(0, 0, roll));
    }

    const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.targetQuaternion);
    this.updateArmOcclusion(landmarks, faceNormal.x);
    const sideFitWeight = THREE.MathUtils.smoothstep(
      Math.abs(faceNormal.x),
      0.08,
      0.46,
    );
    const noseBlend = THREE.MathUtils.lerp(0.35, 1, sideFitWeight);
    const eyeMid = leftEye.clone().add(rightEye).multiplyScalar(0.5);
    const noseContact = bridge.clone().lerp(noseMid, noseBlend);
    const bottomViewWeight = THREE.MathUtils.smoothstep(
      faceNormal.y,
      0.08,
      0.42,
    );
    const sideVerticalContact = THREE.MathUtils.lerp(
      eyeMid.y,
      noseContact.y,
      sideFitWeight,
    );
    const verticalContact = THREE.MathUtils.lerp(
      sideVerticalContact,
      bridge.y,
      bottomViewWeight * 0.78,
    );
    this.targetPosition.set(
      noseContact.x,
      verticalContact + this.fit.height,
      0,
    );

    // Correct projected face width for head yaw. The 3D model itself already
    // foreshortens when rotated, so shrinking it a second time causes a gap.
    const yawCosine = Math.sqrt(Math.max(0, 1 - faceNormal.x * faceNormal.x));
    const correctedTempleSpan = templeSpan / THREE.MathUtils.clamp(yawCosine, 0.68, 1);
    const fittedWidth = correctedTempleSpan * 0.92 * this.fit.size;
    const perspectiveCorrectedScale =
      (fittedWidth * this.cameraDistance) /
      (this.cameraDistance + fittedWidth * (this.frameFrontOffset || 0));
    this.targetScale.setScalar(perspectiveCorrectedScale);

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const positionSmoothing = 1 - Math.exp(-34 * delta);
    const scaleSmoothing = 1 - Math.exp(-20 * delta);
    const rotationSmoothing = 1 - Math.exp(-26 * delta);
    const reacquiredFace = !this.glasses.visible;
    if (reacquiredFace) {
      this.smoothedContact.set(this.targetPosition.x, this.targetPosition.y);
      this.glasses.scale.copy(this.targetScale);
      this.glasses.quaternion.copy(this.targetQuaternion);
    } else {
      this.smoothedContact.lerp(this.targetPosition, positionSmoothing);
      this.glasses.scale.lerp(this.targetScale, scaleSmoothing);
      this.glasses.quaternion.slerp(this.targetQuaternion, rotationSmoothing);
    }

    // Lock the measured GLB bridge to the smoothed nose contact using the
    // model's actual smoothed scale and rotation. Solving after smoothing keeps
    // the constraint intact even during movement, not only after settling.
    this.frontBridgeOffset
      .copy(this.bridgeAnchorLocal)
      .multiplyScalar(this.glasses.scale.x);
    this.rotatedBridgeOffset
      .copy(this.frontBridgeOffset)
      .applyQuaternion(this.glasses.quaternion);
    const cameraDistance = this.cameraDistance;
    const frontProjectionScale =
      cameraDistance / (cameraDistance - this.frontBridgeOffset.z);
    const calibratedBridgeX =
      (this.smoothedContact.x + this.frontBridgeOffset.x) * frontProjectionScale;
    const calibratedBridgeY =
      (this.smoothedContact.y + this.frontBridgeOffset.y) * frontProjectionScale;
    const rotatedDepthScale =
      (cameraDistance - this.rotatedBridgeOffset.z) / cameraDistance;
    this.glasses.position.set(
      calibratedBridgeX * rotatedDepthScale - this.rotatedBridgeOffset.x,
      calibratedBridgeY * rotatedDepthScale - this.rotatedBridgeOffset.y,
      0,
    );
    this.glasses.visible = true;
    this.lastSeenAt = now;
    this.hint.classList.add("is-hidden");
  }

  loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();

    if (
      this.landmarker &&
      this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      this.video.currentTime !== this.lastVideoTime
    ) {
      this.lastVideoTime = this.video.currentTime;
      const result = this.landmarker.detectForVideo(this.video, now);
      this.updatePose(result, now);
    }

    if (this.glasses && now - this.lastSeenAt > 250) {
      this.glasses.visible = false;
      this.hint.classList.remove("is-hidden");
    }
    this.renderer?.render(this.scene, this.camera);
  };

  resetFit() {
    this.fit = { size: 1, height: 0, armDepth: 1.85, noseDepth: 0.09 };
    this.sizeControl.value = "1";
    this.heightControl.value = "0";
    this.armControl.value = "1.85";
    this.noseDepthControl.value = "0.09";
    localStorage.setItem(FIT_STORAGE_KEY, JSON.stringify(this.fit));
    this.applyModelShape();
  }

  stop() {
    this.running = false;
    this.modelLoadId = (this.modelLoadId || 0) + 1;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resizeBound);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
    this.landmarker?.close();
    this.scene?.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material?.dispose());
    });
    this.renderer?.dispose();
    this.sizeControl.removeEventListener("input", this.onFitInput);
    this.heightControl.removeEventListener("input", this.onFitInput);
    this.armControl.removeEventListener("input", this.onFitInput);
    this.noseDepthControl.removeEventListener("input", this.onFitInput);
  }
}
