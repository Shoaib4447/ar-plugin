import "./style.css";
import { formatFrameSize, loadCatalog } from "./catalog.js";

const elements = {
  tryButton: document.querySelector("#try-button"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#status-text"),
  catalogCount: document.querySelector("#catalog-count"),
  productGrid: document.querySelector("#product-grid"),
  tryProductList: document.querySelector("#try-product-list"),
  tryOn: document.querySelector("#try-on"),
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#ar-canvas"),
  hint: document.querySelector("#face-hint"),
  closeButton: document.querySelector("#close-button"),
  liveProductName: document.querySelector("#live-product-name"),
  fitResult: document.querySelector("#fit-result"),
  pdControl: document.querySelector("#pd-control"),
  pdOutput: document.querySelector("#pd-output"),
};

let products = [];
let selectedProduct = null;
let tryOnSession = null;
let switchingProduct = false;
let TryOnSessionClass = null;

function setStatus(message, state = "idle") {
  elements.statusText.textContent = message;
  elements.status.dataset.state = state;
}

function productButton(product, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.productId = product.id;
  button.setAttribute("aria-label", `Try on ${product.name}, size ${formatFrameSize(product)}`);

  if (className === "product-card") {
    button.innerHTML = `
      <span class="product-card-image"><img src="${product.previewUrl}" alt="" /></span>
      <span class="product-card-copy">
        <strong>${product.name}</strong>
        <span>${product.color}</span>
        <span class="frame-size">${formatFrameSize(product)}</span>
      </span>`;
  } else {
    button.innerHTML = `
      <img src="${product.previewUrl}" alt="" />
      <span class="try-product-copy">
        <strong>${product.name}</strong>
        <span>${formatFrameSize(product)} · ${product.dimensions.frameWidthMm} mm wide</span>
      </span>`;
  }

  button.addEventListener("click", () => selectProduct(product, Boolean(tryOnSession)));
  return button;
}

function renderCatalog() {
  elements.catalogCount.textContent = `${products.length} FRAMES`;
  elements.productGrid.replaceChildren(
    ...products.map((product) => productButton(product, "product-card")),
  );
  elements.tryProductList.replaceChildren(
    ...products.map((product) => productButton(product, "try-product")),
  );
  updateProductSelection();
}

function updateProductSelection() {
  document.querySelectorAll("[data-product-id]").forEach((button) => {
    const selected = button.dataset.productId === selectedProduct?.id;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    if (button.classList.contains("try-product")) button.disabled = switchingProduct;
  });
  elements.liveProductName.textContent = selectedProduct
    ? selectedProduct.name.toUpperCase()
    : "LIVE TRY-ON";
}

async function selectProduct(product, switchLive = false) {
  if (!product || product.id === selectedProduct?.id) return;
  const previousProduct = selectedProduct;
  selectedProduct = product;
  updateProductSelection();
  setStatus(`${product.name} selected · ${formatFrameSize(product)}.`, "ready");

  if (!switchLive || !tryOnSession) return;

  switchingProduct = true;
  updateProductSelection();
  elements.hint.textContent = `Loading ${product.name}…`;
  elements.hint.classList.remove("is-hidden");
  elements.fitResult.textContent = "Loading frame";
  elements.fitResult.dataset.fit = "";

  try {
    await tryOnSession.switchProduct(product);
    if (!tryOnSession) return;
    elements.hint.textContent = "Center your face in the frame";
    setStatus(`${product.name} is active.`, "ready");
  } catch (error) {
    if (!tryOnSession) return;
    selectedProduct = previousProduct;
    updateProductSelection();
    if (previousProduct) {
      try {
        await tryOnSession.switchProduct(previousProduct);
      } catch (restoreError) {
        console.error("Could not restore the previous frame.", restoreError);
      }
    }
    elements.hint.textContent = "Could not switch the frame";
    setStatus(error.message, "error");
  } finally {
    switchingProduct = false;
    updateProductSelection();
  }
}

async function startTryOn() {
  if (!selectedProduct || tryOnSession) return;
  elements.tryButton.disabled = true;
  try {
    setStatus("Preparing the fitting engine…", "working");
    if (!TryOnSessionClass) {
      ({ TryOnSession: TryOnSessionClass } = await import("./try-on.js"));
    }

    elements.hint.textContent = "Loading face tracking and the selected frame…";
    elements.tryOn.hidden = false;
    document.body.classList.add("camera-open");
    setStatus(`Loading ${selectedProduct.name}…`, "working");
    tryOnSession = new TryOnSessionClass({
      video: elements.video,
      canvas: elements.canvas,
      hint: elements.hint,
      fitResult: elements.fitResult,
      pdControl: elements.pdControl,
      pdOutput: elements.pdOutput,
    });
    await tryOnSession.start(selectedProduct);
    elements.hint.textContent = "Center your face in the frame";
    setStatus(`${selectedProduct.name} is active.`, "ready");
  } catch (error) {
    closeTryOn();
    if (error.name === "AbortError") return;
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
  switchingProduct = false;
  elements.tryOn.hidden = true;
  elements.hint.textContent = "Center your face in the frame";
  elements.hint.classList.remove("is-hidden");
  elements.fitResult.textContent = "Center your face";
  elements.fitResult.dataset.fit = "";
  document.body.classList.remove("camera-open");
  updateProductSelection();
}

async function initialize() {
  try {
    products = await loadCatalog();
    if (!products.length) throw new Error("The product catalog is empty.");
    selectedProduct = products[0];
    renderCatalog();
    elements.tryButton.disabled = false;
    setStatus(`${products.length} frames ready. Select one to try on.`, "ready");
  } catch (error) {
    elements.tryButton.disabled = true;
    setStatus(error.message, "error");
  }
}

elements.tryButton.disabled = true;
elements.tryButton.addEventListener("click", startTryOn);
elements.closeButton.addEventListener("click", closeTryOn);
window.addEventListener("beforeunload", closeTryOn);
initialize();
