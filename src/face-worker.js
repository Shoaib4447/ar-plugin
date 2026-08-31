import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

let landmarker = null;

async function createWorkerFileset(cacheKey = "") {
  // Module workers cannot use MediaPipe's classic UMD WASM loader: importing
  // that file keeps ModuleFactory scoped to the imported module. The `true`
  // flag selects vision_wasm_module_internal.js, which explicitly publishes
  // ModuleFactory on globalThis for the Tasks runtime.
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL, true);
  if (cacheKey) {
    // MediaPipe consumes and clears ModuleFactory during createFromOptions().
    // A failed GPU initialization therefore needs the loader module to execute
    // again before CPU creation. A distinct URL avoids the ESM import cache.
    fileset.wasmLoaderPath = `${fileset.wasmLoaderPath}?retry=${cacheKey}`;
  }
  return fileset;
}

async function initialize() {
  const vision = await createWorkerFileset();
  const options = {
    baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    numFaces: 1,
    minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
  };

  try {
    landmarker = await FaceLandmarker.createFromOptions(vision, options);
  } catch (gpuError) {
    console.warn("Worker GPU tracking unavailable; using CPU.", gpuError);
    const cpuVision = await createWorkerFileset(`cpu-${Date.now()}`);
    landmarker = await FaceLandmarker.createFromOptions(cpuVision, {
      ...options,
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
    });
  }

  const connections = FaceLandmarker.FACE_LANDMARKS_TESSELATION.map(
    ({ start, end }) => [start, end],
  );
  self.postMessage({ type: "ready", connections });
}

self.addEventListener("message", async (event) => {
  if (event.data?.type === "init") {
    try {
      await initialize();
    } catch (error) {
      self.postMessage({ type: "error", message: error.message });
    }
    return;
  }

  if (event.data?.type !== "frame" || !landmarker) return;
  const { bitmap, timestamp } = event.data;
  try {
    const result = landmarker.detectForVideo(bitmap, timestamp);
    const landmarks = result.faceLandmarks?.[0]?.map(({ x, y, z }) => [x, y, z]);
    const matrixData = result.facialTransformationMatrixes?.[0]?.data;
    self.postMessage({
      type: "result",
      timestamp,
      landmarks: landmarks || null,
      matrix: matrixData ? Array.from(matrixData) : null,
    });
  } catch (error) {
    self.postMessage({ type: "frame-error", message: error.message });
  } finally {
    bitmap.close();
  }
});
