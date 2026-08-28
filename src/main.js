import "./style.css";
import { TryOnSession } from "./try-on.js";

const LOCAL_GLB_URL = "/model/bg-removed.glb";

const elements = {
  tryButton: document.querySelector("#try-button"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  tryOn: document.querySelector("#try-on"),
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#ar-canvas"),
  hint: document.querySelector("#face-hint"),
  closeButton: document.querySelector("#close-button"),
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
  elements.tryButton.disabled = true;
  elements.hint.textContent = "Loading the local model and face tracking…";
  setStatus("Loading the 52 MB local GLB…", "working");
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
    await tryOnSession.start(LOCAL_GLB_URL);
    elements.hint.textContent = "Center your face in the frame";
    setStatus("Camera try-on is running with the local GLB.", "ready");
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
  }
}

function closeTryOn() {
  tryOnSession?.stop();
  tryOnSession = null;
  elements.tryOn.hidden = true;
  elements.hint.textContent = "Center your face in the frame";
  document.body.classList.remove("camera-open");
}

elements.tryButton.addEventListener("click", startTryOn);
elements.closeButton.addEventListener("click", closeTryOn);
elements.resetFit.addEventListener("click", () => tryOnSession?.resetFit());
window.addEventListener("beforeunload", closeTryOn);
