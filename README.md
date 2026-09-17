# World-anchored AR POC

This POC places a toaster and its attached text labels beside a stationary real object. The user selects the object, confirms a detected supporting surface, then moves the phone around it. WebXR supplies the actual camera pose and projection; a native XR anchor supplies the experience's world pose. The toaster keeps its orientation and physical size while its visible perspective changes with the camera.

The original HTML shell, Lottie loader, toaster GLB and three annotation labels are retained. No marker, target-image upload, object-specific training, paid API or application backend is needed. This implementation replaces the NanoTrack/ONNX 2D tracking path.

## Supported devices

The intended first demonstration is **Chrome on a compatible ARCore Android phone or tablet**, with Google Play Services for AR installed and enabled, opened over HTTPS. The browser must support immersive AR with all required features: local reference space, hit testing, anchors and DOM overlay. A general immersive-AR support check cannot establish support for every required feature; starting a session can still fail with device guidance.

Ordinary MacBook browsers and iPhone/iPad Safari do not provide this implementation's required immersive AR feature set. They show an unsupported-device message. There is no webcam or screen-space fallback presented as world tracking. Physical device/browser combinations must be verified before a demonstration. See [Google's WebXR requirements](https://developers.google.com/ar/develop/webxr/requirements).

## Run and use

No build step or runtime npm installation is required. Serve the static project:

~~~sh
python3 -m http.server 8766 --bind 127.0.0.1
~~~

Localhost can be used for desktop UI testing. To use a real Android device, publish over HTTPS or use Chrome DevTools USB port forwarding to device localhost. A plain HTTP LAN address is not a secure context. Open the experience as a top-level page; iframe embedding needs separate permissions-policy and DOM-overlay validation. The host must serve the Draco .wasm asset as application/wasm.

1. Tap **Start AR**, grant the browser's AR/camera permission, and move the phone slowly so it can map nearby surfaces.
2. Draw a rectangle around the stationary object, including its base or the table/floor beneath it. The bottom-center of that selection defines a camera ray. The rectangle identifies a placement area; it is not an object detector or 3D reconstruction.
3. Hold the selected screen position over the supporting surface. A reticle shows a measured surface. **Place here** becomes available only after a suitable surface has remained stable.
4. Tap **Place here**. The toaster is anchored beside that point, initially facing the viewer, and keeps its world orientation thereafter.
5. Walk around slowly to see the toaster from different sides. Text cards, dots and leader lines remain part of the same 3D group; they are not screen-fixed billboards.
6. Use **Labels** to toggle annotations, **New selection** to delete the placement and choose another, or **Close** to end the AR session.

The selection UI also supports keyboard placement through its onscreen instructions. A new placement is required if the world reference space resets. During temporary pose loss, content hides and the native anchor is retained; when tracking recovers, content returns at that anchor. Ending the session deletes the anchor and cancels hit-test sources. The browser/AR runtime owns camera access during the immersive session.

## Scope and limitations

- The selected real object must stay fixed. Moving or rotating that object does not move the anchor with it.
- Selection alone does not measure object shape, identity, center, depth or rotation. Depth comes from a detected supporting surface, so selecting a floating object or a featureless view may never enable placement.
- Placement currently accepts near-horizontal surfaces (within 30 degrees of upright) at 0.25–5 meters. A tabletop or floor close to the object base is the intended target. Wall-mounted or hanging exhibits need a different placement policy.
- Stability requires at least six successive surface observations spanning 180 milliseconds, within the configured position/normal tolerances. This is placement gating, not a guarantee of accuracy.
- There is no artificial orbit, fixed-depth screen placement, edge clamping, per-frame bounding-box positioning or camera-facing label update. The runtime may refine its world map and anchor pose; drift and relocalization quality depend on the physical environment and device.
- Real-object occlusion, object segmentation, photorealistic shadows and persistent cross-session/shared anchors are not implemented. Labels may appear behind other virtual geometry or edge-on as the user walks around, as expected for attached 3D cards.
- All selections load the same toaster manifest. Identifying 200–400 exhibits and selecting different published content is a separate content/identity integration. There is no object recognition, persistent spot database or admin publishing UI in this POC.

Use textured surroundings and good lighting. Physical AR accuracy, depth correctness, drift, thermal behavior and recovery must be evaluated on actual devices; simulated browser checks cannot establish them.

## Implementation and configuration

| File | Responsibility |
| --- | --- |
| src/app.js | Capability checks, user-activated AR session, selection and placement UI, lifecycle and errors |
| src/world-tracker.js | XR hit-test source, measured surface validation, native anchor creation and pose/loss recovery |
| src/world-math.js | Camera-ray unprojection, rigid transforms and fixed placement offsets |
| src/scene.js | Perspective rendering, real GLB, physical dimensions, reticle and anchored group |
| src/annotations.js | Model-parented label cards, leader lines and anchor dots |
| src/config.js | Selection and placement settings |
| assets/experience.json | Local model, physical size and annotation text/layout |

World units are meters. The default toaster width is 0.30 meters across its larger horizontal dimension. The default placement offset is 0.30 meters to the initial viewer's right and 0.015 meters above the hit surface. These offsets remain fixed in the anchor's coordinate system while the camera moves. Change model scale and label content in the experience manifest; change tracking gates/placement offsets through the provider configuration.

The app requests an immersive-ar session directly from the user's button gesture. The Three.js WebXR manager uses the same local reference space as the tracker and renders through the XR animation loop. Placement requests are flags: the provider creates the native anchor from a fresh hit inside the next active XR frame, never from a cached hit or expired frame. Only numeric matrix copies survive frame callbacks. The anchor's current pose is obtained on subsequent frames and applied directly to the common model/annotation root.

## Dependencies and provenance

The runtime uses the browser's WebXR/ARCore implementation plus locally bundled Three.js r136 and matching GLTF/Draco loaders, Draco decoder and Lottie 5.10.2. Their license notices remain under vendor. The supplied [toaster model](https://cdn.pixelbin.io/v2/dummy-cloudname/original/Toaster.glb) and original animation are stored locally; no license for project-supplied media is inferred. vendor/sources.json records upstream URLs and file hashes. The bundled Three.js r136 has a small reproducible XR lifecycle patch: tools/prepare-three-xr.py guards session setup that resolves after cancellation and safely stops an animation loop before its XR context exists. The script checks upstream/derived hashes and verifies that reversing its exact replacements restores the original file; the original MIT license is retained.

There is no 8th Wall dependency, cloud anchor service, ONNX runtime, object-tracking model, application telemetry or upload endpoint in this build. Hosting is ordinary static hosting. Device/browser platform terms still apply. The relevant standards are [WebXR hit testing](https://immersive-web.github.io/hit-test/) and [WebXR anchors](https://immersive-web.github.io/anchors/).

## Automated checks

Use Node.js 20 or newer:

~~~sh
npm test
~~~

The provider tests cover camera-ray geometry, stable-surface gating, anchor lifecycle, loss and recovery, cancellation and late async results. The implementation uses local source and deterministic synthetic XR frames for these checks.

For browser integration testing, install Playwright separately or set PLAYWRIGHT_MODULE_PATH to an existing module directory. CHROME_PATH can select an installed Chrome binary. With the app served locally:

~~~sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser -- http://127.0.0.1:8766
~~~

Reports/screenshots default to work/world-qa; QA_OUTPUT_DIR changes that directory. QA_CASE filters case names. The harness checks the actual unsupported-desktop path without an XR mock. Supported-flow tests explicitly install tests/fixtures/webxr-fixture.cjs with Playwright addInitScript. That fixture simulates a device's WebXR API and camera motion while the production application, provider, actual toaster GLB and Three.js renderer run normally. No test hooks or synthetic pose provider are installed in production.

The browser suite verifies selection-ray coordinates, live-frame anchor creation, perspective changes during a simulated camera orbit while the model and labels keep the same world transforms, surface/loss gating, annotation toggles, permission retry, anchor deletion, and session restart in portrait and landscape layouts. These are integration checks, not proof of real-world 3D tracking accuracy or phone performance.

Before showing the POC to a client, test the HTTPS build on target Android hardware: near/far placement, a slow full walk around a stationary exhibit, pauses, temporary occlusion, return to the original view, background/foreground transitions, repeated selections and session closure. Record drift and alignment against an identifiable physical reference rather than relying only on whether a virtual model appears stable.
