import { buildMeshCachesFromPositions, orientShells } from './meshcore.js';

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
    const resolve = pending.get(e.data.id);
    if (resolve) { pending.delete(e.data.id); resolve(e.data); }
  };
  worker.onerror = () => { // a broken worker shouldn't wedge the app
    for (const [, resolve] of pending) resolve(null);
    pending.clear();
    worker = null;
  };
  return worker;
}

/** Post a job to the worker with a transferred copy of `positions`; resolves
 *  with the worker's reply, or null if the worker died. */
function postJob(kind, positions) {
  return new Promise((resolve) => {
    const id = seq++;
    pending.set(id, resolve);
    const copy = positions.slice(); // don't detach the caller's buffer
    getWorker().postMessage({ id, kind, positions: copy }, [copy.buffer]);
  });
}

const useWorker = (positions) => typeof Worker !== 'undefined' && positions.length / 9 >= WORKER_MIN_TRIS;

/**
 * @param positions Float32Array of the geometry's vertex coords (NOT detached —
 *   a copy is transferred to the worker).
 */
export async function buildMeshCachesAsync(positions) {
  if (!useWorker(positions)) return buildMeshCachesFromPositions(positions);
  const r = await postJob('caches', positions);
  return r ? { triCount: r.triCount, adjacency: r.adjacency, triNormals: r.triNormals, triCentroids: r.triCentroids }
    : buildMeshCachesFromPositions(positions);
}

/**
 * Repair winding so every shell is consistent and outward-facing (see
 * meshcore.orientShells). Resolves { positions, stats } — `positions` is the
 * repaired array (the input itself on the inline path, a fresh array from the
 * worker), so always use the returned one.
 */
export async function orientShellsAsync(positions) {
  if (useWorker(positions)) {
    const r = await postJob('orient', positions);
    if (r) return { positions: r.positions, stats: r.stats };
  }
  const stats = orientShells(positions);
  return { positions, stats };
}
