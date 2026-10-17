/**
 * Main-thread orchestrator for the emboss feature. Turns the per-glyph surface
 * placements (from curvedtext.js) into 3D geometry: traces each glyph mask to
 * polygons, builds a placement matrix, hands the heavy manifold-3d boolean to a
 * worker, then tags the new text faces with the active group and swaps the
 * geometry into the painter (which rebuilds caches/BVH and clears undo).
 *
 * Falls back to running the boolean on the main thread if the worker or its WASM
 * can't start, so the feature still works everywhere the boolean does.
 */
import * as THREE from 'three';
import { traceMask } from './masktrace.js';

const EPS_MM = 0.2; // surface overlap so the boolean fuses cleanly (from the spike)

// ---- worker plumbing (with main-thread fallback) ----
let worker = null, seq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./emboss.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id } = e.data; const res = pending.get(id);
      if (res) { pending.delete(id); res(e.data); }
    };
    worker.onerror = () => { for (const [, r] of pending) r({ ok: false, error: 'worker error' }); pending.clear(); worker = null; };
  } catch { worker = null; }
  return worker;
}

let mainWasm = null;
async function runOnMainThread(modelSoup, glyphs, depthMm, mode) {
  if (!mainWasm) {
    const [{ default: Module }, { default: wasmUrl }] = await Promise.all([
      import('manifold-3d'),
      import('manifold-3d/manifold.wasm?url'),
    ]);
    mainWasm = await Module({ locateFile: () => wasmUrl });
    mainWasm.setup();
  }
  const { runEmboss } = await import('./emboss-core.js');
  return { ok: true, ...runEmboss(mainWasm, modelSoup, glyphs, depthMm, mode) };
}

function runBoolean(modelSoup, glyphs, depthMm, mode) {
  const w = getWorker();
  if (!w) return runOnMainThread(modelSoup, glyphs, depthMm, mode);
  return new Promise((resolve) => {
    const id = seq++;
    pending.set(id, resolve);
    const copy = modelSoup.slice(); // transferred; don't detach the live buffer
    w.postMessage({ id, modelSoup: copy, glyphs, depthMm, mode }, [copy.buffer]);
  }).then((r) => (r.ok ? r : runOnMainThread(modelSoup, glyphs, depthMm, mode)));
}

// ---- glyph placement -> polygons + matrix ----
/** One glyph's traced outline polygons in local mm coords (x along T, y along B),
 *  matching the exact mapping buildTextClassifier uses, so the solid lands where
 *  the painted text would. */
function glyphPolys(p) {
  const loops = traceMask(p.mask, p.w, p.h);
  return loops.map((loop) => loop.map(([px, py]) => [
    (px / p.w - 0.5) * 2 * p.halfW,
    (0.5 - py / p.h) * 2 * p.halfH,
  ]));
}

/** 3x4 column-major placement matrix: columns T, B, N, origin. Local Z (extrude
 *  axis) maps to the surface normal; the glyph straddles the surface by EPS so
 *  the boolean overlaps (raise protrudes outward, engrave digs inward). */
function glyphMatrix(p, depthMm, mode) {
  const { P, N, T, B } = p;
  const zShift = mode === 'engrave' ? -depthMm : -EPS_MM;
  const tgt = mode === 'engrave'
    ? { x: P.x + N.x * EPS_MM, y: P.y + N.y * EPS_MM, z: P.z + N.z * EPS_MM }
    : P;
  return [T.x, T.y, T.z, B.x, B.y, B.z, N.x, N.y, N.z,
    tgt.x + N.x * zShift, tgt.y + N.y * zShift, tgt.z + N.z * zShift];
}

// ---- old-face group lookup (preserve existing paint on model faces) ----
function faceLookup(painter) {
  const geo = painter.mesh.geometry;
  const pos = geo.attributes.position.array;
  const n = painter.triCount;
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const q = (bb.min.distanceTo(bb.max) || 1) * 1e-6;
  const key = new Map();
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
    key.set(`${Math.round(cx / q)}_${Math.round(cy / q)}_${Math.round(cz / q)}`, t);
  }
  const V = new THREE.Vector3();
  return (cx, cy, cz) => {
    const k = `${Math.round(cx / q)}_${Math.round(cy / q)}_${Math.round(cz / q)}`;
    let t = key.get(k);
    if (t === undefined) { t = painter.nearestFace(V.set(cx, cy, cz)); }
    return t >= 0 ? t : 0;
  };
}

/**
 * Build embossed geometry for the given per-glyph placements and swap it into
 * the painter. `mode` is 'raise' | 'engrave'. Returns stats. Throws on failure
 * (caller restores UI). Clears undo history (geometry change), like subdivision.
 */
export async function applyEmboss(painter, placements, { mode, depthMm }) {
  if (!painter.mesh || !placements.length) throw new Error('nothing to emboss');
  const glyphs = placements.map((p) => ({ polys: glyphPolys(p), mat: glyphMatrix(p, depthMm, mode) }))
    .filter((g) => g.polys.length);
  if (!glyphs.length) throw new Error('no glyph outlines traced');

  const group = painter.activeGroup;
  const lookup = faceLookup(painter);            // built on the OLD geometry/BVH
  const modelSoup = painter.mesh.geometry.attributes.position.array;

  const res = await runBoolean(modelSoup, glyphs, depthMm, mode);
  if (!res.ok) throw new Error(res.error || 'emboss boolean failed');
  const { positions, isText } = res;
  const triCount = positions.length / 9;

  const triGroup = new Uint16Array(triCount);
  const blocked = new Uint8Array(triCount);
  let textFaces = 0;
  for (let t = 0; t < triCount; t++) {
    if (isText[t]) { triGroup[t] = group; textFaces++; continue; }
    const o = t * 9;
    const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    const src = lookup(cx, cy, cz);
    triGroup[t] = painter.triGroup[src];
    blocked[t] = painter.blocked[src];
  }

  await painter.adoptRefined(positions, triGroup, blocked);
  return { triCount, textFaces, filledLoops: res.filledLoops || 0 };
}
