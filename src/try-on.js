import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { LowPassMeasurement, StableFitState } from "./fit-stability.js";
import { createHeadOccluderShape } from "./head-occlusion.js";
import {
  createArmFadeRange,
  patchLegacyEyewearShader,
} from "./arm-fade.js";

const PD_STORAGE_KEY = "frame-lab-pupillary-distance-v1";
const DEFAULT_PD_MM = 63;
const TRACKING_INTERVAL_MS = 1000 / 30;
const TRACKING_LOST_GRACE_MS = 750;

const LANDMARK = {
  LEFT_EYE_OUTER: 33,
  RIGHT_EYE_OUTER: 263,
  NOSE_BRIDGE: 168,
  NOSE_MID: 6,
  LEFT_TEMPLE: 234,
  RIGHT_TEMPLE: 454,
  LEFT_IRIS: 468,
  RIGHT_IRIS: 473,
};

function loadPupillaryDistance() {
  const stored = Number(localStorage.getItem(PD_STORAGE_KEY));
  return Number.isFinite(stored)
    ? THREE.MathUtils.clamp(stored, 48, 78)
    : DEFAULT_PD_MM;
}

function triangulateConnections(connections) {
  const neighbors = new Map();
  const edges = [];
  for (const [start, end] of connections) {
    if (!neighbors.has(start)) neighbors.set(start, new Set());
    if (!neighbors.has(end)) neighbors.set(end, new Set());
    neighbors.get(start).add(end);
    neighbors.get(end).add(start);
    edges.push([start, end]);
  }

  const triangles = new Map();
  for (const [start, end] of edges) {
    for (const third of neighbors.get(start)) {
      if (!neighbors.get(end)?.has(third)) continue;
      const triangle = [start, end, third].sort((a, b) => a - b);
      triangles.set(triangle.join("-"), triangle);
    }
  }
  return Array.from(triangles.values()).flat();
}

export class TryOnSession {
  constructor({ video, canvas, hint, fitResult, pdControl, pdOutput }) {
    this.video = video;
    this.canvas = canvas;
    this.hint = hint;
    this.fitResult = fitResult;
    this.pdControl = pdControl;
    this.pdOutput = pdOutput;
    this.pupillaryDistanceMm = loadPupillaryDistance();
    this.pdControl.value = String(this.pupillaryDistanceMm);
    this.pdOutput.value = String(this.pupillaryDistanceMm);

    this.clock = new THREE.Clock();
    this.targetPosition = new THREE.Vector3();
    this.targetScale = new THREE.Vector3(1, 1, 1);
    this.targetQuaternion = new THREE.Quaternion();
    this.poseMatrix = new THREE.Matrix4();
    this.posePosition = new THREE.Vector3();
    this.poseScale = new THREE.Vector3();
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.lastSeenAt = 0;
    this.lastFitKey = "";
    this.trackingBusy = false;
    this.running = false;
    this.irisSpanFilter = new LowPassMeasurement({
      alpha: 0.2,
      maxRelativeStep: 0.055,
      minStep: 0.0004,
    });
    this.faceWidthFilter = new LowPassMeasurement({
      alpha: 0.13,
      maxRelativeStep: 0.06,
      minStep: 0.4,
    });
    this.headWidthFilter = new LowPassMeasurement({
      alpha: 0.18,
      maxRelativeStep: 0.045,
      minStep: 0.0005,
    });
    this.fitState = new StableFitState({
      enterMm: 8,
      exitMm: 4,
      holdMs: 360,
      displayStepMm: 2,
    });

    this.onPdInput = () => {
      this.pupillaryDistanceMm = Number(this.pdControl.value);
      this.pdOutput.value = String(this.pupillaryDistanceMm);
      localStorage.setItem(PD_STORAGE_KEY, String(this.pupillaryDistanceMm));
    };
    this.pdControl.addEventListener("input", this.onPdInput);
  }

  async start(product) {
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
      if (typeof createImageBitmap !== "function") {
        throw new Error("This browser cannot prepare camera frames for face tracking.");
      }

      await Promise.all([this.initTracker(), this.initRenderer(product)]);
      this.initFaceOccluder();
      this.initHeadOccluder();
      this.resize();
      window.addEventListener("resize", this.resizeBound);
      this.loop();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  initTracker() {
    return new Promise((resolve, reject) => {
      this.rejectTrackerInit = reject;
      this.trackerWorker = new Worker(new URL("./face-worker.js", import.meta.url), {
        type: "module",
      });

      this.trackerWorker.addEventListener("message", (event) => {
        if (event.data?.type === "ready") {
          this.faceConnections = event.data.connections;
          this.rejectTrackerInit = null;
          resolve();
          return;
        }
        if (event.data?.type === "error") {
          this.rejectTrackerInit = null;
          reject(new Error(event.data.message));
          return;
        }
        if (event.data?.type === "result") {
          this.trackingBusy = false;
          this.handleTrackingResult(event.data);
          return;
        }
        if (event.data?.type === "frame-error") {
          this.trackingBusy = false;
          console.warn("A face-tracking frame was skipped.", event.data.message);
        }
      });
      this.trackerWorker.addEventListener("error", (event) => {
        this.trackingBusy = false;
        this.rejectTrackerInit = null;
        reject(new Error(event.message || "Face tracking could not start."));
      });
      this.trackerWorker.postMessage({ type: "init" });
    });
  }

  async initRenderer(product) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    const verticalFov = 50;
    this.camera = new THREE.PerspectiveCamera(verticalFov, 1, 0.01, 20);
    this.cameraDistance = 0.5 / Math.tan(THREE.MathUtils.degToRad(verticalFov / 2));
    this.camera.position.set(0, 0, this.cameraDistance);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x5b6470, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(-2, 3, 4);
    this.scene.add(key);

    this.glasses = new THREE.Group();
    this.glasses.visible = false;
    this.glasses.renderOrder = 2;
    this.scene.add(this.glasses);
    this.resizeBound = () => this.resize();
    await this.switchProduct(product);
  }

  initFaceOccluder() {
    const indices = triangulateConnections(this.faceConnections || []);
    if (!indices.length) return;

    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(478 * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", positions);
    geometry.setIndex(indices);

    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });
    this.faceOccluder = new THREE.Mesh(geometry, material);
    this.faceOccluder.name = "live-face-depth-occluder";
    this.faceOccluder.visible = false;
    this.faceOccluder.frustumCulled = false;
    this.faceOccluder.renderOrder = 0;
    this.scene.add(this.faceOccluder);
  }

  initHeadOccluder() {
    // The landmark mesh stops around the side of the face. A depth-only
    // ellipsoid continues that surface through the temples and back of head,
    // allowing even a fused GLB's arms to be naturally clipped at the skin.
    const geometry = new THREE.SphereGeometry(1, 40, 28);
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.FrontSide,
      toneMapped: false,
    });
    this.headOccluder = new THREE.Mesh(geometry, material);
    this.headOccluder.name = "tracked-head-depth-occluder";
    this.headOccluder.visible = false;
    this.headOccluder.frustumCulled = false;
    this.headOccluder.renderOrder = 0;
    this.scene.add(this.headOccluder);
  }

  async switchProduct(product) {
    if (this.product?.id === product.id && this.model) return true;

    const loadId = (this.modelLoadId || 0) + 1;
    this.modelLoadId = loadId;
    const previousModel = this.model;
    if (previousModel) {
      this.glasses.visible = false;
      this.glasses.remove(previousModel);
      this.disposeObject(previousModel);
      this.renderer?.renderLists?.dispose();
      this.model = null;
      this.product = null;
    }

    const gltf = await new GLTFLoader().loadAsync(product.modelUrl);
    if (loadId !== this.modelLoadId || !this.glasses) {
      this.disposeObject(gltf.scene);
      return false;
    }

    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.x) || size.x <= 0 || size.z <= 0) {
      this.disposeObject(model);
      throw new Error(`${product.name} has invalid model dimensions.`);
    }

    this.model = model;
    this.product = product;
    this.modelBounds = bounds;
    this.modelSize = size;
    this.modelCenter = bounds.getCenter(new THREE.Vector3());
    this.modelBridgePoint = this.findModelBridgePoint();
    this.applyProductGeometry();
    this.prepareMaterials();
    this.glasses.add(model);
    this.glasses.visible = false;
    this.lastFitKey = "";
    this.fitState.reset();
    return true;
  }

  findModelBridgePoint() {
    const bridgeSum = new THREE.Vector3();
    let count = 0;
    const centerStrip = this.modelSize.x * 0.025;
    const frontZ = this.modelBounds.max.z;

    this.model.traverse((node) => {
      if (!node.isMesh) return;
      const position = node.geometry?.getAttribute("position");
      if (!position) return;
      for (let index = 0; index < position.count; index += 1) {
        const x = position.getX(index);
        const z = position.getZ(index);
        const depthFromFront = (frontZ - z) / this.modelSize.z;
        if (Math.abs(x - this.modelCenter.x) <= centerStrip && depthFromFront <= 0.3) {
          bridgeSum.set(
            bridgeSum.x + x,
            bridgeSum.y + position.getY(index),
            bridgeSum.z + z,
          );
          count += 1;
        }
      }
    });

    return count
      ? bridgeSum.multiplyScalar(1 / count)
      : new THREE.Vector3(this.modelCenter.x, this.modelCenter.y, frontZ);
  }

  applyProductGeometry() {
    if (!this.model || !this.product) return;
    const widthScale = 1 / this.modelSize.x;
    const targetDepthRatio =
      this.product.dimensions.templeLengthMm / this.product.dimensions.frameWidthMm;
    const depthScale = targetDepthRatio / this.modelSize.z;

    this.model.scale.set(widthScale, widthScale, depthScale);
    this.model.position.set(
      -this.modelBridgePoint.x * widthScale,
      -this.modelBridgePoint.y * widthScale,
      -this.modelBridgePoint.z * depthScale,
    );
  }

  prepareMaterials() {
    this.model.traverse((node) => {
      if (!node.isMesh) return;
      node.castShadow = false;
      node.frustumCulled = false;
      node.renderOrder = 2;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => {
        if (!material) return;
        material.depthTest = true;
        const semanticName = `${node.name} ${material.name}`.toLowerCase();
        if (semanticName.includes("lens")) {
          material.transparent = true;
          material.opacity = Math.min(material.opacity ?? 1, 0.34);
          material.depthWrite = false;
          material.roughness = Math.max(material.roughness ?? 0, 0.08);
          material.needsUpdate = true;
        } else if (this.product.assetStatus === "legacy-demo") {
          this.applyLegacyMaterialEffects(node, material);
        }
      });
    });
  }

  applyLegacyMaterialEffects(node, material) {
    node.geometry.computeBoundingBox();
    const bounds = node.geometry.boundingBox;
    const fadeRange = createArmFadeRange(bounds?.min.z, bounds?.max.z);
    if (!fadeRange) return;

    const applyLensFallback = Boolean(material.map);
    material.transparent = true;
    material.depthWrite = true;
    // Fully transparent tip fragments should not leave an invisible depth edge.
    material.alphaTest = Math.max(material.alphaTest || 0, 0.01);
    material.onBeforeCompile = (shader) => {
      patchLegacyEyewearShader(shader, fadeRange, applyLensFallback);
    };
    material.customProgramCacheKey = () =>
      `frame-lab-legacy-eyewear-v2-${applyLensFallback ? "mapped" : "plain"}`;
    material.needsUpdate = true;
  }

  disposeObject(object) {
    if (!object) return;
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    object.traverse((node) => {
      if (!node.isMesh) return;
      if (node.geometry) geometries.add(node.geometry);
      const nodeMaterials = Array.isArray(node.material) ? node.material : [node.material];
      nodeMaterials.forEach((material) => {
        if (!material) return;
        materials.add(material);
        Object.values(material).forEach((value) => {
          if (value?.isTexture) textures.add(value);
        });
      });
    });
    textures.forEach((texture) => texture.dispose());
    materials.forEach((material) => material.dispose());
    geometries.forEach((geometry) => geometry.dispose());
  }

  resize() {
    if (!this.renderer || !this.camera) return;
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.aspect = width / height;
    this.camera.aspect = this.aspect;
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
    return new THREE.Vector2((screenX - 0.5) * this.aspect, 0.5 - screenY);
  }

  updateFaceOccluder(landmarks) {
    if (!this.faceOccluder) return;
    const position = this.faceOccluder.geometry.getAttribute("position");
    const bridgeDepth = landmarks[LANDMARK.NOSE_BRIDGE]?.z || 0;
    const blend = this.faceOccluder.visible ? 0.42 : 1;
    for (let index = 0; index < position.count; index += 1) {
      const point = landmarks[index];
      if (!point) {
        position.setXYZ(index, 0, 0, -10);
        continue;
      }
      const mapped = this.mapLandmark(point);
      const depth = -(point.z - bridgeDepth) * this.aspect - 0.004;
      position.setXYZ(
        index,
        THREE.MathUtils.lerp(position.getX(index), mapped.x, blend),
        THREE.MathUtils.lerp(position.getY(index), mapped.y, blend),
        THREE.MathUtils.lerp(position.getZ(index), depth, blend),
      );
    }
    position.needsUpdate = true;
    this.faceOccluder.visible = true;
  }

  updateHeadOccluder(correctedTempleSpan) {
    if (!this.headOccluder) return;

    const stableFaceWidth = this.headWidthFilter.update(correctedTempleSpan);
    const shape = createHeadOccluderShape(stableFaceWidth);
    if (shape.radiusX <= 0) return;

    // Follow the exact smoothed pose used by the glasses. Keeping this as a
    // separate scene object avoids product scale affecting the shopper's head.
    this.headOccluder.quaternion.copy(this.glasses.quaternion);
    this.headOccluder.scale.set(shape.radiusX, shape.radiusY, shape.radiusZ);

    const centerOffset = new THREE.Vector3(0, shape.centerY, shape.centerZ)
      .applyQuaternion(this.headOccluder.quaternion);
    this.headOccluder.position.copy(this.glasses.position).add(centerOffset);
    this.headOccluder.visible = true;
  }

  handleTrackingResult({ landmarks: packedLandmarks, matrix }) {
    if (!this.running || !packedLandmarks) return;
    const landmarks = packedLandmarks.map(([x, y, z]) => ({ x, y, z }));
    // Use arrival time for visibility. On slower devices the worker result may
    // arrive hundreds of milliseconds after its source-frame timestamp.
    this.updatePose(landmarks, matrix, performance.now());
  }

  updatePose(landmarks, matrixData, now) {
    if (!this.model || !this.product) return;
    const leftEye = this.mapLandmark(landmarks[LANDMARK.LEFT_EYE_OUTER]);
    const rightEye = this.mapLandmark(landmarks[LANDMARK.RIGHT_EYE_OUTER]);
    const bridge = this.mapLandmark(landmarks[LANDMARK.NOSE_BRIDGE]);
    const noseMid = this.mapLandmark(landmarks[LANDMARK.NOSE_MID]);
    const leftTemple = this.mapLandmark(landmarks[LANDMARK.LEFT_TEMPLE]);
    const rightTemple = this.mapLandmark(landmarks[LANDMARK.RIGHT_TEMPLE]);
    const leftIris = landmarks[LANDMARK.LEFT_IRIS]
      ? this.mapLandmark(landmarks[LANDMARK.LEFT_IRIS])
      : leftEye;
    const rightIris = landmarks[LANDMARK.RIGHT_IRIS]
      ? this.mapLandmark(landmarks[LANDMARK.RIGHT_IRIS])
      : rightEye;
    const irisSpan = leftIris.distanceTo(rightIris);
    const templeSpan = leftTemple.distanceTo(rightTemple);
    if (irisSpan < 0.015 || templeSpan < 0.04) return;

    if (matrixData?.length === 16) {
      this.poseMatrix.fromArray(matrixData);
      this.poseMatrix.decompose(this.posePosition, this.targetQuaternion, this.poseScale);
    } else {
      const roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);
      this.targetQuaternion.setFromEuler(new THREE.Euler(0, 0, roll));
    }

    const faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.targetQuaternion);
    const yawCosine = Math.sqrt(Math.max(0, 1 - faceNormal.x * faceNormal.x));
    const yawCorrection = THREE.MathUtils.clamp(yawCosine, 0.7, 1);
    const correctedIrisSpan = this.irisSpanFilter.update(irisSpan / yawCorrection);
    const correctedTempleSpan = templeSpan / yawCorrection;
    const sideFitWeight = THREE.MathUtils.smoothstep(Math.abs(faceNormal.x), 0.08, 0.46);
    const noseContact = bridge.clone().lerp(noseMid, sideFitWeight * 0.62);

    this.targetPosition.set(noseContact.x, noseContact.y, 0.012);
    const fittedWidth =
      correctedIrisSpan *
      (this.product.dimensions.frameWidthMm / this.pupillaryDistanceMm);
    this.targetScale.setScalar(fittedWidth);

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const positionSmoothing = 1 - Math.exp(-13 * delta);
    const scaleSmoothing = 1 - Math.exp(-10 * delta);
    const rotationSmoothing = 1 - Math.exp(-15 * delta);
    const reacquiredFace = !this.glasses.visible;
    if (reacquiredFace) {
      this.glasses.position.copy(this.targetPosition);
      this.glasses.scale.copy(this.targetScale);
      this.glasses.quaternion.copy(this.targetQuaternion);
    } else {
      if (this.glasses.position.distanceTo(this.targetPosition) < 0.0012) {
        this.targetPosition.copy(this.glasses.position);
      }
      const currentScale = this.glasses.scale.x;
      if (
        currentScale > 0 &&
        Math.abs(this.targetScale.x - currentScale) / currentScale < 0.006
      ) {
        this.targetScale.copy(this.glasses.scale);
      }
      if (this.glasses.quaternion.angleTo(this.targetQuaternion) < 0.006) {
        this.targetQuaternion.copy(this.glasses.quaternion);
      }
      this.glasses.position.lerp(this.targetPosition, positionSmoothing);
      this.glasses.scale.lerp(this.targetScale, scaleSmoothing);
      this.glasses.quaternion.slerp(this.targetQuaternion, rotationSmoothing);
    }

    this.updateFaceOccluder(landmarks);
    this.updateHeadOccluder(correctedTempleSpan);
    this.updateFitResult(correctedTempleSpan, correctedIrisSpan, now);
    this.glasses.visible = true;
    this.lastSeenAt = now;
    this.hint.classList.add("is-hidden");
  }

  updateFitResult(templeSpan, irisSpan, now) {
    const rawFaceWidthMm = (templeSpan / irisSpan) * this.pupillaryDistanceMm * 1.1;
    const estimatedFaceWidthMm = this.faceWidthFilter.update(rawFaceWidthMm);
    const difference = this.product.dimensions.frameWidthMm - estimatedFaceWidthMm;
    const stableResult = this.fitState.update(difference, now);
    if (!stableResult) return;
    const { fit, differenceMm } = stableResult;
    const label =
      fit === "balanced"
        ? `Balanced · about ${differenceMm} mm difference`
        : `${fit === "narrow" ? "Narrow" : "Wide"} · about ${differenceMm} mm`;
    const key = `${fit}:${label}`;
    if (key === this.lastFitKey) return;
    this.lastFitKey = key;
    this.fitResult.textContent = label;
    this.fitResult.dataset.fit = fit;
  }

  requestTrackingFrame(now) {
    if (
      this.trackingBusy ||
      !this.trackerWorker ||
      typeof createImageBitmap !== "function" ||
      now - this.lastInferenceAt < TRACKING_INTERVAL_MS ||
      this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      this.video.currentTime === this.lastVideoTime
    ) {
      return;
    }

    this.trackingBusy = true;
    this.lastInferenceAt = now;
    this.lastVideoTime = this.video.currentTime;
    createImageBitmap(this.video)
      .then((bitmap) => {
        if (!this.running || !this.trackerWorker) {
          bitmap.close();
          this.trackingBusy = false;
          return;
        }
        this.trackerWorker.postMessage({ type: "frame", bitmap, timestamp: now }, [bitmap]);
      })
      .catch((error) => {
        this.trackingBusy = false;
        console.warn("Could not prepare a camera frame for tracking.", error);
      });
  }

  loop = () => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);
    const now = performance.now();
    this.requestTrackingFrame(now);

    if (
      (this.glasses?.visible || this.faceOccluder?.visible || this.headOccluder?.visible) &&
      now - this.lastSeenAt > TRACKING_LOST_GRACE_MS
    ) {
      this.glasses.visible = false;
      if (this.faceOccluder) this.faceOccluder.visible = false;
      if (this.headOccluder) this.headOccluder.visible = false;
      this.hint.classList.remove("is-hidden");
      this.fitResult.textContent = "Center your face";
      this.fitResult.dataset.fit = "";
      this.lastFitKey = "";
      this.irisSpanFilter.reset();
      this.faceWidthFilter.reset();
      this.headWidthFilter.reset();
      this.fitState.reset();
    }
    this.renderer?.render(this.scene, this.camera);
  };

  stop() {
    this.running = false;
    this.modelLoadId = (this.modelLoadId || 0) + 1;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resizeBound);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.video.srcObject = null;
    this.trackerWorker?.terminate();
    this.trackerWorker = null;
    this.rejectTrackerInit?.(new DOMException("Try-on was closed.", "AbortError"));
    this.rejectTrackerInit = null;
    this.scene?.traverse((node) => {
      if (!node.isMesh) return;
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material?.dispose());
    });
    this.renderer?.dispose();
    this.pdControl.removeEventListener("input", this.onPdInput);
  }
}
