const REQUIRED_DIMENSIONS = [
  "frameWidthMm",
  "lensWidthMm",
  "lensHeightMm",
  "bridgeWidthMm",
  "templeLengthMm",
];

function validateProduct(product, ids) {
  if (!product?.id || ids.has(product.id)) {
    throw new Error(`Catalog product has a missing or duplicate id: ${product?.id || "unknown"}.`);
  }
  ids.add(product.id);

  for (const field of ["name", "modelUrl", "previewUrl"]) {
    if (typeof product[field] !== "string" || !product[field]) {
      throw new Error(`Catalog product ${product.id} is missing ${field}.`);
    }
  }

  for (const field of REQUIRED_DIMENSIONS) {
    const value = product.dimensions?.[field];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Catalog product ${product.id} has an invalid ${field}.`);
    }
  }

  return Object.freeze({
    ...product,
    dimensions: Object.freeze({ ...product.dimensions }),
  });
}

export async function loadCatalog() {
  const response = await fetch("/catalog/products.json", { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`Could not load the product catalog (HTTP ${response.status}).`);
  }

  const catalog = await response.json();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.products)) {
    throw new Error("The product catalog uses an unsupported schema.");
  }

  const ids = new Set();
  return catalog.products.map((product) => validateProduct(product, ids));
}

export function formatFrameSize(product) {
  const { lensWidthMm, bridgeWidthMm, templeLengthMm } = product.dimensions;
  return `${lensWidthMm}-${bridgeWidthMm}-${templeLengthMm}`;
}
