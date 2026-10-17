// Runs the manifold-3d emboss boolean off the main thread (see emboss-core.js).
// manifold-3d is a WASM module; Vite serves its .wasm via the ?url import and we
// point Emscripten's locateFile at it. The module is initialised lazily on the
// first job so loading the worker stays cheap.
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { runEmboss } from './emboss-core.js';

let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) wasmPromise = Module({ locateFile: () => wasmUrl }).then((w) => { w.setup(); return w; });
  return wasmPromise;
}

self.onmessage = async (e) => {
  const { id, modelSoup, glyphs, depthMm, mode } = e.data;
  try {
    const wasm = await getWasm();
    const { positions, isText, filledLoops } = runEmboss(wasm, modelSoup, glyphs, depthMm, mode);
    self.postMessage({ id, ok: true, positions, isText, filledLoops }, [positions.buffer, isText.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err && err.message ? err.message : String(err) });
  }
};
