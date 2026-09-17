# Cup → Toaster POC

A static browser experience that uses WebAR.rocks.object to track a coffee cup and Three.js to display the supplied toaster with attached annotations. The original page shell and Lottie loader have been retained. GlamAR code and credentials are removed.

## Run

From this project directory:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://localhost:8765`. For phone testing, serve this directory on **HTTPS**. A phone opening a computer's plain HTTP LAN address does not get the localhost camera exemption. No build or package installation is needed. Enable gzip/Brotli for the network JSON and JavaScript in your static host.

Use **Start camera** for live tracking; the rear camera is preferred. **Preview model** opens a separate, clearly labelled model viewer and does not use or simulate cup recognition. Close the current session to switch modes. Labels can be toggled. Rescan resets detection.

## Target and model

- Tracking target: `CUP`, using the official `NN_COFFEE_2.json` network.
- Display model: supplied [Toaster.glb](https://cdn.pixelbin.io/v2/dummy-cloudname/original/Toaster.glb), stored locally unchanged (Draco compressed).
- Any cup is **not** guaranteed. Start with a conventional opaque coffee cup in good light, keep the entire cup visible, and move slowly. Unusual shapes, clear glass, shiny metal, occlusion, and poor lighting can reduce reliability. Verify your specific cup.
- One target at a time. Content hides after tracking is lost and reappears after reacquisition. There are no persistent room anchors or real-object depth occlusion.
- The estimated camera field of view and model placement require calibration with an actual cup. This POC has not been validated on physical iOS or Android devices yet.

## Configuration

`src/config.js` contains model/network URLs, model placement and size in tracker-relative units, annotation anchor positions, loss tolerance, and detection cadence. Annotation points are fractions of the normalized model bounding box. Rendering and the detector share a centered cover crop; the detector source is refreshed on intrinsic video-size changes.

`src/tracker.js` owns the singleton tracking core and its lifecycle. `src/scene.js` owns rendering, pose conversion, stabilization, the model preview, and projected annotations. `src/app.js` owns camera permissions and UI state. Add `?debug=1` to see detection state and score.

## Dependencies

All runtime assets are served locally. Three.js and addons are pinned to r136 to match the standalone upstream integration baseline. WebAR.rocks.object is pinned by commit. Exact origins, file sizes, and SHA-256 hashes are recorded in `vendor/sources.json`.

Upstream license notices are included for WebAR.rocks.object, Three.js, Draco, and Lottie. The toaster and loader animation were supplied by the project owner; their original source URLs are recorded. No license for those assets is inferred.

## Validation

Browser checks cover actual GLB/Draco decoding, model preview and label toggling, mobile viewport layout, actual tracking-engine initialization against a synthetic camera stream, rescanning, stopping, and reinitialization. Additional checks cover denied-camera recovery, missing-network errors, and annotation movement/loss/reacquisition with injected detection output. Synthetic checks establish runtime integration only; they do not establish real-cup recognition accuracy or mobile hardware performance.

Before treating this as a demonstrated AR result, test the actual cup on target phones, including camera/object movement, rotation, temporary occlusion, loss/reacquisition, and changes in lighting.
