let runtimePromise;

function ready(candidate) {
  return !!candidate?.Mat && typeof candidate.goodFeaturesToTrack === 'function'
    && typeof candidate.calcOpticalFlowPyrLK === 'function' && typeof candidate.findHomography === 'function';
}

/** The pinned OpenCV.js build initializes WASM asynchronously in workers and windows. */
export function loadOpenCV(url = new URL('../vendor/opencv/opencv.js', import.meta.url).href, timeoutMs = 12_000) {
  // Emscripten's Module can be a self-thenable. Never resolve/await it directly.
  if (ready(globalThis.cv)) return Promise.resolve({ cv: globalThis.cv });
  if (runtimePromise) return runtimePromise;
  runtimePromise = new Promise((resolve, reject) => {
    let finished = false, script, poll;
    const controller = new AbortController();
    const finish = (error, cv) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(poll);
      if (error) { controller.abort(); script?.remove(); reject(error); }
      else resolve({ cv });
    };
    const timer = setTimeout(() => finish(new Error('Visual feature refinement is unavailable; continuing with NanoTrack.')), timeoutMs);
    const inspect = () => {
      if (finished) return;
      const candidate = globalThis.cv;
      if (ready(candidate)) return finish(null, candidate);
      if (candidate?.then) {
        candidate.then(cv => {
          if (ready(cv)) finish(null, cv);
          else finish(new Error('The OpenCV build does not include the required tracking modules.'));
        }, error => finish(error));
        return;
      }
      poll = setTimeout(inspect, 30);
    };
    try {
      if (globalThis.cv) { inspect(); return; }
      if (typeof importScripts === 'function') {
        // Fetch asynchronously so a slow optional download cannot block the
        // worker's timeout and keep the working NanoTrack path from starting.
        fetch(url, { signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error(`OpenCV could not load (${response.status}).`);
          const source = await response.text();
          if (finished) return;
          const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
          try { importScripts(blobUrl); }
          finally { URL.revokeObjectURL(blobUrl); }
          inspect();
        }).catch(error => finish(error));
      } else {
        script = document.createElement('script');
        script.src = url;
        script.onload = inspect;
        script.onerror = () => finish(new Error('Visual feature refinement could not load; continuing with NanoTrack.'));
        document.head.append(script);
      }
    } catch (error) { finish(error); }
  }).catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}
