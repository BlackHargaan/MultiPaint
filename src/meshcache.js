import { buildMeshCachesFromPositions } from './meshcore.js';

/**
 * Build per-triangle caches (adjacency, normals, centroids) off the main
 * thread when Web Workers are available, so importing a big mesh or rebuilding
 * after subdivision doesn't freeze the UI. Falls back to synchronous
 * computation where Workers aren't available (e.g. Node test runs). Small
 * meshes are done inline — the worker round-trip isn't worth it.
 */

const WORKER_MIN_TRIS = 20000;

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./meshcache.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, triCount, adjacency, triNormals, triCentroids } = e.data;
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve({ triCount, adjacency, triNormals, triCentroids }); }
  };
  worker.onerror = () => { // a broken worker shouldn't wedge the app
    for (const [, resolve] of pending) resolve(null);
    pending.clear();
    worker = null;
  };
  return worker;
}

/**
 * @param positions Float32Array of the geometry's vertex coords (NOT detached —
 *   a copy is transferred to the worker).
 */
export function buildMeshCachesAsync(positions) {
  const triCount = positions.length / 9;
  if (typeof Worker === 'undefined' || triCount < WORKER_MIN_TRIS) {
    return Promise.resolve(buildMeshCachesFromPositions(positions));
  }
  return new Promise((resolve) => {
    const id = seq++;
    pending.set(id, (caches) => resolve(caches || buildMeshCachesFromPositions(positions)));
    const copy = positions.slice(); // don't detach the geometry's buffer
    getWorker().postMessage({ id, positions: copy }, [copy.buffer]);
  });
}
