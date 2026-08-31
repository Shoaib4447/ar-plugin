# Frame Lab eyewear asset contract

Every production product must provide a GLB and verified physical dimensions.
The runtime fits any asset that follows this contract; it must not contain
per-product offsets or shopper-specific calibration values.

## GLB requirements

- glTF 2.0 binary (`.glb`), using metres (`1 unit = 1 metre`).
- Front of the lenses faces positive Z.
- The root origin is centered at the eyewear bridge contact point.
- Temple pivots are placed at their physical hinges.
- Required nodes: `Frame`, `TempleR`, `TempleL`, `LensR`, `LensL`.
- Lenses use `KHR_materials_transmission`; do not bake lenses into the frame texture.
- Mobile delivery target: at most 5 MB and 100,000 triangles.
- Use Meshopt or Draco for geometry and KTX2/Basis for textures where supported.

Continuous-lens products may use one `Lens` node after the validator and runtime
are extended to declare that product type explicitly.

## Catalog requirements

Each product in `public/catalog/products.json` requires:

- A stable, store-scoped product or variant ID.
- Product name, color, preview URL, and model URL.
- Verified `frameWidthMm`, `lensWidthMm`, `lensHeightMm`, `bridgeWidthMm`, and
  `templeLengthMm` measurements.
- `assetStatus: "production"` only after automated validation and visual QA.

The current three products use `assetStatus: "legacy-demo"`. This permits the
validator to report their fused meshes and large files as warnings so the
multi-product fitting flow can be tested. New merchant products must not use
this escape hatch.

Run `pnpm validate:catalog` before deploying catalog changes.
