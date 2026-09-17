# Selection-based object tracking POC

Open the camera, draw a rectangle around one visible object, and a toaster with three attached labels follows the selected region. This version uses pretrained NanoTrack V2, ONNX Runtime Web, and Three.js. The original page shell and Lottie loader are retained.

## Run and use

No build or runtime package installation is needed. From this directory:

~~~sh
python3 -m http.server 8766 --bind 127.0.0.1
~~~

Open http://localhost:8766 on the same computer. Publish these static files over HTTPS to test on a phone or tablet; a plain HTTP LAN address does not get the localhost camera exemption. The host must serve .wasm as application/wasm and .mjs as JavaScript. GitHub Pages supports the required static hosting.

1. Select **Start camera** and allow access. The rear camera is preferred where available.
2. Drag a rectangle around an object, keeping it tight enough to exclude unrelated background. Touch dragging works on mobile. Releasing the rectangle starts tracking.
3. Move the object or camera slowly. The toaster and its labels follow the tracked screen position and approximate size.
4. Use **Labels** to toggle annotations, **New selection** to choose a new object, and **Close** to stop the camera.

Keyboard selection: focus the camera selection area, press Enter to create a centered box, use arrow keys to move it and Shift + arrows to resize it, then press Enter to track. Escape cancels the draft. A camera frame freezes briefly while drawing so the selected rectangle matches the tracker's reference frame. There is no separate photo-capture, upload, or model-preview workflow.

If confidence drops, content hides. After sustained loss, the app asks for another selection; it does not claim to identify or automatically re-find the same object. Returning from a background tab also requires a new selection. Closing releases camera tracks and tracking resources.

## What the POC demonstrates

- One manually selected object at a time, without category-specific detection or per-object training.
- Local inference using a fixed reference patch captured internally from the live camera; camera pixels are not sent to a server.
- A real, locally stored Draco-compressed toaster GLB with label cards, leader lines, and anchor dots parented to its Three.js group.
- Position and size following, smoothing, small-selection guidance, tracking-loss handling, permission retry, and session restart.

This is 2D visual tracking with a 3D content overlay. The tracker returns a bounding box, not the object's physical 3D position or rotation. The toaster has a fixed display orientation. Its labels share the content group and would follow an applied content rotation, but walking around an object does not currently produce a physically correct change of viewpoint. Full 360-degree tracking, world anchors, real-object occlusion, and persistent recognition are outside this POC.

An arbitrary region can be selected, but reliable tracking of every object is not guaranteed. Featureless, reflective, small, obscured, or rapidly moving objects and large viewpoint changes are difficult. Test with a clearly visible, textured target in good light. Tracking scores are similarity scores, not calibrated probabilities.

The browser needs camera access in a secure context, WebGL, and WebAssembly SIMD. Inference normally runs in a worker with OffscreenCanvas and transferable ImageBitmap. A main-thread fallback is included where those worker features are unavailable. Actual frame rate and compatibility must be checked on target devices, particularly iOS Safari and Android browsers. Desktop browser checks and mobile viewport checks do not establish physical-device support.

## Implementation and configuration

| File | Responsibility |
| --- | --- |
| src/app.js | Camera, rectangular selection, lifecycle, tracking loop, and UI states |
| src/geometry.js | Centered cover-crop mapping between camera pixels and screen coordinates |
| src/tracker.js | Worker adapter, main-thread fallback, cancellation and timeouts |
| src/nanotrack.worker.js | Serialized worker requests |
| src/nanotrack-core.js | Reference/search preprocessing, ONNX inference, bounding-box decoding and confidence gating |
| src/scene.js | Three.js model, screen-relative placement, smoothing and rendering |
| src/annotations.js | Model-parented label cards and leader lines |
| src/config.js | Processing resolution, update cadence and loss thresholds |
| assets/experience.json | Toaster asset, annotation text, normalized anchor positions and layout |

Frames are downsampled to a maximum dimension of 640 pixels. Inference is capped at 15 requests per second with at most one in flight; rendering runs independently. ONNX uses the WASM execution provider with one thread, so cross-origin isolation headers are not required. The roughly 11 MB WASM binary is loaded locally; first startup depends on download and initialization time. The whole static project is approximately 17 MB before HTTP compression.

All selections resolve to the same demo experience. This does not recognize object names or map 200–400 physical spots to different content. A later content service can replace the local manifest. Spot identification and content lookup, plus a provider that supplies camera/object pose for true 3D anchoring, need separate implementation and evaluation.

## Dependencies and provenance

Runtime files are bundled locally; this POC calls no paid tracking or AI service.

- NanoTrack V2 from HonglinChu/SiamTrackers at commit 248663fde6bf7c40190cf10ee396d5662919ecd3; pretrained models and Apache 2.0 license in assets/nanotrack.
- ONNX Runtime Web 1.20.1, pinned npm package, with MIT license and third-party notices in vendor/onnx.
- Three.js r136 and matching GLTF/Draco loaders, Draco decoder, and Lottie 5.10.2 with bundled license notices.
- The supplied [toaster model](https://cdn.pixelbin.io/v2/dummy-cloudname/original/Toaster.glb) and original loader animation are stored locally. No license for project-supplied media is inferred.

Exact upstream URLs, sizes, SHA-256 hashes, and ONNX package integrity are recorded in vendor/sources.json. The upstream NanoTrack backbone has fixed spatial metadata, although the network is fully convolutional. tools/prepare-nanotrack.py changes only that metadata to allow both 127×127 reference and 255×255 search inputs. It verifies graph operators and weights remain byte-for-byte identical; no retraining occurs. See assets/nanotrack/README.md for reproducibility.

## Validation

Use Node.js 20 or newer:

~~~sh
npm test
~~~

This checks portrait/landscape crop geometry, reversed drags, invalid boxes, downsampling, NanoTrack RGB preprocessing, response-grid decoding, and low-confidence state retention.

For controlled browser QA, install Playwright separately (or set PLAYWRIGHT_MODULE_PATH to an existing module directory) and install its Chromium browser. With this app served locally:

~~~sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser -- http://127.0.0.1:8766
~~~

CHROME_PATH may point to an installed Chrome binary. QA_OUTPUT_DIR controls report/screenshot output, defaulting to work/qa. The harness supplies a generated textured-phone camera stream and runs the real bundled ONNX models. It checks desktop and portrait selection, translation/scale following, labels, loss/reselection, denied-camera recovery, and camera shutdown. It does not inject tracker results. These checks establish integration behavior on controlled frames; they do not establish accuracy on arbitrary physical objects or performance on mobile hardware.

Before a client demonstration, test the hosted build with actual phones, tablets and laptop cameras, including movement, target removal, lighting changes, background/foreground transitions and repeated selection.
