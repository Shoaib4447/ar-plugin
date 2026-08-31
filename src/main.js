import "./style.css";
import { TryOnSession } from "./try-on.js";

const MODEL_DETAILS = {
  "/model/bg-removed.glb": { name: "Classic acetate", size: "52 MB" },
  "/model/metal-frame.glb": { name: "Round wire frame", size: "57 MB" },
};

const elements = {
  tryButton: document.querySelector("#try-button"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  tryOn: document.querySelector("#try-on"),
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#ar-canvas"),
  hint: document.querySelector("#face-hint"),
  closeButton: document.querySelector("#close-button"),
  modelControl: document.querySelector("#model-control"),
  sizeControl: document.querySelector("#size-control"),
  heightControl: document.querySelector("#height-control"),
  armControl: document.querySelector("#arm-control"),
  noseDepthControl: document.querySelector("#nose-depth-control"),
  resetFit: document.querySelector("#reset-fit"),
};

let tryOnSession = null;

function setStatus(message, state = "idle") {
  elements.statusText.textContent = message;
  elements.status.dataset.state = state;
}

async function startTryOn() {
  const modelUrl = elements.modelControl.value;
  const modelDetails = MODEL_DETAILS[modelUrl];
  elements.tryButton.disabled = true;
  elements.modelControl.disabled = true;
  elements.hint.textContent = "Loading the local model and face tracking…";
  setStatus(`Loading ${modelDetails?.size || "local"} GLB…`, "working");
  elements.tryOn.hidden = false;
  document.body.classList.add("camera-open");

  tryOnSession = new TryOnSession({
    video: elements.video,
    canvas: elements.canvas,
    hint: elements.hint,
    sizeControl: elements.sizeControl,
    heightControl: elements.heightControl,
    armControl: elements.armControl,
    noseDepthControl: elements.noseDepthControl,
  });

  try {
    await tryOnSession.start(modelUrl);
    elements.hint.textContent = "Center your face in the frame";
    setStatus(`${modelDetails?.name || "Selected model"} is active.`, "ready");
  } catch (error) {
    closeTryOn();
    setStatus(
      error.name === "NotAllowedError"
        ? "Camera permission was denied. Allow camera access and try again."
        : error.message,
      "error",
    );
  } finally {
    elements.tryButton.disabled = false;
    elements.modelControl.disabled = false;
  }
}

async function switchLiveModel() {
  const session = tryOnSession;
  if (!session) return;
  const previousModelUrl = session.activeModelUrl;
  const modelUrl = elements.modelControl.value;
  const modelDetails = MODEL_DETAILS[modelUrl];
  elements.modelControl.disabled = true;
  elements.hint.textContent = `Loading ${modelDetails?.name || "model"}…`;
  elements.hint.classList.remove("is-hidden");
  setStatus(`Loading ${modelDetails?.size || "local"} GLB…`, "working");

  try {
    await session.switchModel(modelUrl);
    if (tryOnSession !== session) return;
    elements.hint.textContent = "Center your face in the frame";
    setStatus(`${modelDetails?.name || "Selected model"} is active.`, "ready");
  } catch (error) {
    if (tryOnSession !== session) return;
    if (previousModelUrl) {
      elements.modelControl.value = previousModelUrl;
      elements.hint.textContent = "Restoring the previous glasses…";
      try {
        await session.switchModel(previousModelUrl);
        if (tryOnSession !== session) return;
        elements.hint.textContent = "Center your face in the frame";
        setStatus(
          `Could not load ${modelDetails?.name || "the selected model"}: ${error.message}. ${MODEL_DETAILS[previousModelUrl]?.name || "Previous model"} was restored.`,
          "error",
        );
      } catch (restoreError) {
        if (tryOnSession !== session) return;
        elements.hint.textContent = "Could not switch the glasses model";
        setStatus(restoreError.message || error.message, "error");
      }
    } else {
      elements.hint.textContent = "Could not switch the glasses model";
      setStatus(error.message, "error");
    }
  } finally {
    if (tryOnSession === session) elements.modelControl.disabled = false;
  }
}

function closeTryOn() {
  tryOnSession?.stop();
  tryOnSession = null;
  elements.tryOn.hidden = true;
  elements.hint.textContent = "Center your face in the frame";
  elements.modelControl.disabled = false;
  document.body.classList.remove("camera-open");
}

elements.tryButton.addEventListener("click", startTryOn);
elements.closeButton.addEventListener("click", closeTryOn);
elements.modelControl.addEventListener("change", switchLiveModel);
elements.resetFit.addEventListener("click", () => tryOnSession?.resetFit());
window.addEventListener("beforeunload", closeTryOn);
