export const CONFIG = Object.freeze({
  modelUrl: './assets/Toaster.glb',
  modelSource: 'https://cdn.pixelbin.io/v2/dummy-cloudname/original/Toaster.glb',
  networkUrl: './assets/NN_COFFEE_2.json',
  // The neural network uses a unit-width detection window, not physical metres.
  modelWidth: 0.9,
  modelOffset: [0, 0.7, 0],
  modelRotation: [0, 0, 0],
  cameraMinDimensionFov: 35,
  maxPixelRatio: 1.5,
  detectIntervalMs: 1000 / 30,
  revealFrames: 3,
  lostAfterMs: 220,
  annotations: [
    { title: 'Toast slots', detail: 'Top opening', point: [0.5, 0.96, 0.5], offset: [-125, -70] },
    { title: 'Control dial', detail: 'Front controls', point: [0.92, 0.33, 0.5], offset: [85, 25] },
    { title: 'Toaster body', detail: 'Outer housing', point: [0.45, 0.5, 0.95], offset: [-145, 55] },
  ],
});
