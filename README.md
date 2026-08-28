# AR Glasses — Version 0

This round skips image-to-GLB generation completely. The app loads the supplied
local model at `public/model/bg-removed.glb`, opens the camera, tracks one
face locally with MediaPipe, and renders the glasses with Three.js.

There is no Tripo API request, API key requirement, generation charge, upload,
database, webhook, cloud storage, Shopify integration, or deployment setup.

## Run it

Requirements: Node.js 20+ and pnpm.

```powershell
pnpm install
pnpm dev
```

Open the exact URL printed by Vite—normally `http://localhost:5173`—and click
**Start camera try-on**.

Camera access works on `localhost`. Access from another phone or computer must
use HTTPS because browsers block cameras on insecure origins.

## Current model

- File: `public/model/bg-removed.glb`
- Size: approximately 52.6 MB
- Mesh: approximately 900k vertices
- Source metadata: Meshy

The model is intentionally used unchanged for the first fit test. If loading or
mobile frame rate is poor, the next step is mesh and texture compression—not a
new application architecture.

## POC behavior

- Face video is processed locally in the browser.
- Frame size and vertical fit are saved in `localStorage`.
- A depth-only face ellipsoid provides basic temple-arm occlusion.
- Face tracking tries the GPU first and falls back to CPU.

## Intentionally deferred

- Image-to-GLB generation and Tripo billing
- Shopify integration and merchant/product selection
- Permanent model storage/CDN
- Per-SKU calibration and production model QA
