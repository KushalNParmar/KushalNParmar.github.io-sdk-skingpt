# Hybrid selection tracking POC

Open the camera, draw a rectangle around one visible object, and a toaster with three attached labels follows the selected region. This experiment combines pretrained NanoTrack V2, ONNX Runtime Web, OpenCV.js feature tracking, and Three.js. The original page shell and Lottie loader are retained. It replaces the WebXR-only version with the ordinary camera flow; no immersive AR session, plane scan or separate placement button is required.

## Run and use

No build or runtime package installation is needed. From this directory:

~~~sh
python3 -m http.server 8766 --bind 127.0.0.1
~~~

Open http://localhost:8766 on the same computer. Publish these static files over HTTPS to test on a phone or tablet; a plain HTTP LAN address does not get the localhost camera exemption. The host must serve .wasm as application/wasm and .mjs as JavaScript. GitHub Pages supports the required static hosting.

1. Select **Start camera** and allow access. The rear camera is preferred where available.
2. Drag a rectangle around an object, keeping it tight enough to exclude unrelated background. Touch dragging works on mobile. Releasing the rectangle starts tracking.
3. Keep the object fixed and move the camera slowly, keeping the same side visible. The toaster follows its position and approximate size. When enough visual features remain visible, the toaster and all labels rotate together with measured rotation in the camera image.
4. Use **Labels** to toggle annotations, **New selection** to choose a new object, and **Close** to stop the camera.

Keyboard selection: focus the camera selection area, press Enter to create a centered box, use arrow keys to move it and Shift + arrows to resize it, then press Enter to track. Escape cancels the draft. A camera frame freezes briefly while drawing so the selected rectangle matches the tracker's reference frame. There is no separate photo-capture, upload, or model-preview workflow.

If confidence drops, the app holds the last pose for at most 220 ms, then hides the overlay while trying to match the original selection again. It allows a three-second recovery window and requires two reliable results before showing the overlay again. Sustained loss asks for a new selection. This limited reference matching is not object identity recognition or persistent reacquisition. Returning from a background tab also requires a new selection. Closing releases camera tracks and tracking resources.

## What the POC demonstrates

- One manually selected object at a time, without category-specific detection or per-object training.
- Local inference using a fixed reference patch captured internally from the live camera; camera pixels are not sent to a server.
- A real, locally stored Draco-compressed toaster GLB with label cards, leader lines, and anchor dots parented to its Three.js group.
- Position and size following, confidence-gated image-plane rotation, lower display smoothing delay, stable placement side, small-selection guidance, brief-loss recovery, permission retry, and session restart.

This is image-based tracking with a 3D content overlay. OpenCV tracks feature points using forward/backward optical flow, fits a robust homography and checks spatial coverage, reprojection error and geometric plausibility. NanoTrack supplies appearance matching; the combined tracker rejects implausible jumps and does not silently retrain on a doubtful frame. Reliable geometry refines the bounding box and supplies screen-plane rotation (roll).

**This does not recover physical 3D pose.** Yaw/pitch and depth are not derived from a rectangle, and walking around the side or back of an arbitrary cup does not produce physically correct 3D perspective. Rotation is measured from image features, not animated or inferred from left/right movement. The last measured orientation is held if only NanoTrack remains reliable. Full 360-degree tracking, world anchors, real-object occlusion, and persistent recognition remain outside this experiment. The labels, leader lines and model share one rotation parent.

An arbitrary region can be selected, but reliable tracking of every object is not guaranteed. Featureless, reflective, small, obscured, or rapidly moving objects and large viewpoint changes are difficult. Test with a clearly visible, textured target in good light. Tracking scores are similarity scores, not calibrated probabilities.

The browser needs camera access in a secure context, WebGL, and WebAssembly SIMD. Mobile/tablet Safari and Chrome are the evaluation priority; there is no WebXR/ARCore requirement. Inference normally runs in a worker with OffscreenCanvas and transferable ImageBitmap. A main-thread fallback is included where those worker features are unavailable. If OpenCV cannot initialize, NanoTrack position/size tracking remains available. Actual frame rate and compatibility must be checked on target devices, particularly iOS Safari and Android browsers. Desktop browser checks and mobile viewport checks do not establish physical-device support.

## Implementation and configuration

| File | Responsibility |
| --- | --- |
| src/app.js | Camera, rectangular selection, lifecycle, tracking loop, and UI states |
| src/geometry.js | Centered cover-crop mapping between camera pixels and screen coordinates |
| src/tracker.js | Worker adapter, main-thread fallback, cancellation and timeouts |
| src/nanotrack.worker.js | Serialized worker requests |
| src/nanotrack-core.js | Reference/search preprocessing, ONNX inference, bounding-box decoding and confidence gating |
| src/hybrid-core.js | Shared frame handling, NanoTrack/feature fusion, fallback and cleanup |
| src/feature-tracker.js | OpenCV feature tracking and reference matching |
| src/tracking-math.js | Geometry validation and fusion confidence gates |
| src/opencv-runtime.js | Local OpenCV loading and initialization |
| src/scene.js, src/pose-math.js | Model/labels, measured image-plane rotation, placement and rendering |
| src/annotations.js | Model-parented label cards and leader lines |
| src/config.js | Processing resolution, update cadence and loss thresholds |
| assets/experience.json | Toaster asset, annotation text, normalized anchor positions and layout |

Frames are downsampled to a maximum dimension of 640 pixels. Inference is capped at 15 requests per second with at most one in flight; rendering runs independently. ONNX uses the WASM execution provider with one thread, so cross-origin isolation headers are not required. ONNX's roughly 11 MB WASM binary and OpenCV's roughly 11 MB single-file runtime are bundled locally. First startup depends on download and initialization time; the static project is approximately 28 MB before HTTP compression. Browser caching can reduce subsequent downloads.

All selections resolve to the same demo experience. This does not recognize object names or map 200–400 physical spots to different content. A later content service can replace the local manifest. Spot identification and content lookup, plus a provider that supplies camera/object pose for true 3D anchoring, need separate implementation and evaluation.

## Dependencies and provenance

Runtime files are bundled locally; this POC calls no paid tracking or AI service.

- NanoTrack V2 from HonglinChu/SiamTrackers at commit 248663fde6bf7c40190cf10ee396d5662919ecd3; pretrained models and Apache 2.0 license in assets/nanotrack.
- ONNX Runtime Web 1.20.1, pinned npm package, with MIT license and third-party notices in vendor/onnx.
- OpenCV.js 4.13.0, official single-file WASM distribution, with Apache 2.0 license in vendor/opencv. The binary is unmodified; its required exported APIs are checked at initialization.
- Three.js r136 and matching GLTF/Draco loaders, Draco decoder, and Lottie 5.10.2 with bundled license notices.
- The supplied [toaster model](https://cdn.pixelbin.io/v2/dummy-cloudname/original/Toaster.glb) and original loader animation are stored locally. No license for project-supplied media is inferred.

Exact upstream URLs, sizes, SHA-256 hashes, and ONNX package integrity are recorded in vendor/sources.json. The upstream NanoTrack backbone has fixed spatial metadata, although the network is fully convolutional. tools/prepare-nanotrack.py changes only that metadata to allow both 127×127 reference and 255×255 search inputs. It verifies graph operators and weights remain byte-for-byte identical; no retraining occurs. See assets/nanotrack/README.md for reproducibility.

## Validation

Use Node.js 20 or newer:

~~~sh
npm test
~~~

This checks crop geometry, selection mapping, NanoTrack preprocessing/decoding, feature/fusion geometry and confidence gates, and measured roll/angle wrapping. The implementation does not call a paid tracking or recognition service.

For controlled browser QA, install Playwright separately (or set PLAYWRIGHT_MODULE_PATH to an existing module directory) and install its Chromium browser. With this app served locally:

~~~sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser -- http://127.0.0.1:8766
~~~

CHROME_PATH may point to an installed Chrome binary. QA_OUTPUT_DIR controls report/screenshot output. The harness supplies a generated textured-phone camera stream and runs the real bundled ONNX models and OpenCV algorithms. It measures translation/scale/roll and observes the actual Three.js model/label transforms, including recovery, reselection, shutdown and OpenCV-unavailable fallback. It does not inject tracker results. These checks establish integration behavior on controlled frames; they do not establish accuracy on arbitrary physical objects or performance on mobile hardware.

Before a client demonstration, test the hosted build with actual phones, tablets and laptop cameras, including movement, target removal, lighting changes, background/foreground transitions and repeated selection.

## Next evaluation

If this experiment still falls short on mobile/tablet hardware, evaluate Zappar Universal AR instant world tracking separately with its time-limited trial. It is not integrated or activated here. A trial is not an unrestricted public production license; confirm current hosting and commercial terms before a client release. No MindAR dependency is used.
