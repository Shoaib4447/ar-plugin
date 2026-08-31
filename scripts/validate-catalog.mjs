import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = path.join(workspace, "public", "catalog", "products.json");
const requiredNodes = ["Frame", "TempleR", "TempleL", "LensR", "LensL"];
const requiredDimensions = [
  "frameWidthMm",
  "lensWidthMm",
  "lensHeightMm",
  "bridgeWidthMm",
  "templeLengthMm",
];
const errors = [];
const warnings = [];

function parseGlb(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("utf8", 0, 4) !== "glTF" || buffer.readUInt32LE(4) !== 2) {
    throw new Error("not a binary glTF 2.0 file");
  }
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(
    buffer.subarray(20, 20 + jsonLength).toString("utf8").replace(/\0+$/, ""),
  );
  return { buffer, json };
}

function inspectProduct(product) {
  const prefix = product.id || "unknown-product";
  const isLegacy = product.assetStatus === "legacy-demo";
  const report = (message) => (isLegacy ? warnings : errors).push(`${prefix}: ${message}`);

  if (!product.id || !product.name || !product.modelUrl || !product.previewUrl) {
    errors.push(`${prefix}: id, name, modelUrl and previewUrl are required`);
    return null;
  }
  for (const field of requiredDimensions) {
    if (!Number.isFinite(product.dimensions?.[field]) || product.dimensions[field] <= 0) {
      errors.push(`${prefix}: dimensions.${field} must be a positive number`);
    }
  }

  const relativeModelPath = product.modelUrl.replace(/^\//, "");
  const modelPath = path.join(workspace, "public", relativeModelPath);
  if (!fs.existsSync(modelPath)) {
    errors.push(`${prefix}: model does not exist at ${product.modelUrl}`);
    return null;
  }

  try {
    const { buffer, json } = parseGlb(modelPath);
    const nodeNames = new Set((json.nodes || []).map((node) => node.name).filter(Boolean));
    const missingNodes = requiredNodes.filter((name) => !nodeNames.has(name));
    if (missingNodes.length) report(`missing semantic nodes: ${missingNodes.join(", ")}`);

    let triangles = 0;
    for (const mesh of json.meshes || []) {
      for (const primitive of mesh.primitives || []) {
        const indexCount = json.accessors?.[primitive.indices]?.count;
        const positionCount = json.accessors?.[primitive.attributes?.POSITION]?.count || 0;
        triangles += (indexCount || positionCount) / 3;
      }
    }
    const sizeMb = buffer.byteLength / 1024 / 1024;
    if (sizeMb > 5) report(`${sizeMb.toFixed(1)} MB exceeds the 5 MB mobile target`);
    if (triangles > 100000) {
      report(`${Math.round(triangles).toLocaleString()} triangles exceed the 100,000 target`);
    }
    if (!(json.extensionsUsed || []).includes("KHR_materials_transmission")) {
      report("KHR_materials_transmission is not declared for physical lenses");
    }

    return {
      id: product.id,
      sizeMb: sizeMb.toFixed(1),
      triangles: Math.round(triangles).toLocaleString(),
      status: isLegacy ? "legacy demo" : "production",
    };
  } catch (error) {
    errors.push(`${prefix}: ${error.message}`);
    return null;
  }
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.products)) {
  errors.push("catalog: schemaVersion 1 and a products array are required");
}

const ids = new Set();
const reports = [];
for (const product of catalog.products || []) {
  if (ids.has(product.id)) errors.push(`${product.id}: duplicate product id`);
  ids.add(product.id);
  const report = inspectProduct(product);
  if (report) reports.push(report);
}

console.table(reports);
warnings.forEach((warning) => console.warn(`WARN ${warning}`));
errors.forEach((error) => console.error(`ERROR ${error}`));

if (errors.length) {
  console.error(`Catalog validation failed with ${errors.length} error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Catalog validation passed with ${warnings.length} legacy warning(s).`);
}
