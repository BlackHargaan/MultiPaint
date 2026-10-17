/**
 * Pure geometry core for emboss (no DOM, no three) so it runs in a worker.
 *
 * Pipeline (validated in scripts/csg-spike): repair the model into a watertight
 * manifold (weld -> hole-fill -> orient), build each glyph as a manifold solid
 * from its 2D polygons (CrossSection.extrude) placed by a per-glyph matrix,
 * union the glyphs, then boolean against the model (add = raised, subtract =
 * engraved). manifold-3d is watertight by construction, unlike three-bvh-csg.
 *
 * Face origin tracking (manifold originalIDs) tells us which output triangles
 * came from the text, so the caller can paint exactly those with the active
 * filament group.
 */

/** Weld a triangle soup (9 floats/tri) into indexed {positions[], index[]}. */
function weld(soup) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = diag * 1e-6;
  const key = (x, y, z) => `${Math.round(x / q)}_${Math.round(y / q)}_${Math.round(z / q)}`;
  const ids = new Map();
  const positions = [];
  const index = new Array(soup.length / 3);
  for (let v = 0; v < soup.length / 3; v++) {
    const x = soup[v * 3], y = soup[v * 3 + 1], z = soup[v * 3 + 2];
    const k = key(x, y, z);
    let id = ids.get(k);
    if (id === undefined) { id = positions.length / 3; ids.set(k, id); positions.push(x, y, z); }
    index[v] = id;
  }
  return { positions, index, diag };
}

/** Fill boundary holes: chain boundary half-edges into loops, fan-fill each. */
function fillHoles(positions, index) {
  const dir = new Set();
  for (let t = 0; t < index.length / 3; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    dir.add(a * 1e8 + b); dir.add(b * 1e8 + c); dir.add(c * 1e8 + a);
  }
  const next = new Map();
  for (let t = 0; t < index.length / 3; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2];
    for (const [u, w] of [[a, b], [b, c], [c, a]]) if (!dir.has(w * 1e8 + u)) next.set(u, w);
  }
  const outPos = positions.slice(), outIdx = index.slice();
  let loops = 0;
  const visited = new Set();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop = []; let v = start, guard = 0;
    while (v !== undefined && !visited.has(v) && guard++ < 1e7) { visited.add(v); loop.push(v); v = next.get(v); }
    if (loop.length < 3) continue;
    loops++;
    let cx = 0, cy = 0, cz = 0;
    for (const vi of loop) { cx += outPos[vi * 3]; cy += outPos[vi * 3 + 1]; cz += outPos[vi * 3 + 2]; }
    const ci = outPos.length / 3;
    outPos.push(cx / loop.length, cy / loop.length, cz / loop.length);
    for (let i = 0; i < loop.length; i++) outIdx.push(ci, loop[(i + 1) % loop.length], loop[i]);
  }
  return { positions: outPos, index: outIdx, loops };
}

/** Flip winding when the mesh is inside-out (negative signed volume). */
function orient(positions, index) {
  let v6 = 0;
  for (let t = 0; t < index.length / 3; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    v6 += positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
        - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
        + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (v6 >= 0) return index;
  const out = index.slice();
  for (let t = 0; t < out.length / 3; t++) { const tmp = out[t * 3 + 1]; out[t * 3 + 1] = out[t * 3 + 2]; out[t * 3 + 2] = tmp; }
  return out;
}

/** Repair a soup into a manifold-ready indexed mesh. Returns {positions,index,loops}. */
export function repair(soup) {
  const w = weld(soup);
  const f = fillHoles(w.positions, w.index);
  const index = orient(f.positions, f.index);
  return { positions: f.positions, index, filledLoops: f.loops };
}

/**
 * Run the emboss boolean. `wasm` is an initialised manifold-3d module.
 *   modelSoup : Float32Array, 9 floats/triangle (the current mesh)
 *   glyphs    : [{ polys:[[ [x,y],... ], ...], mat:[12 floats col-major 3x4] }]
 *   depthMm   : extrusion depth
 *   mode      : 'raise' | 'engrave'
 * Returns { positions:Float32Array soup, isText:Uint8Array per triangle, filledLoops }.
 */
export function runEmboss(wasm, modelSoup, glyphs, depthMm, mode) {
  const { Manifold, Mesh, CrossSection } = wasm;
  const rep = repair(modelSoup);
  const modelMesh = new Mesh({ numProp: 3, vertProperties: Float32Array.from(rep.positions), triVerts: Uint32Array.from(rep.index) });
  let modelMan = new Manifold(modelMesh).asOriginal();
  const modelId = modelMan.originalID();

  let textMan = null;
  for (const g of glyphs) {
    if (!g.polys.length) continue;
    let cs = new CrossSection(g.polys, 'EvenOdd');
    let solid = Manifold.extrude(cs, depthMm).transform(g.mat);
    cs.delete?.();
    textMan = textMan ? textMan.add(solid) : solid;
  }
  if (!textMan) throw new Error('no glyph solids');
  textMan = textMan.asOriginal();
  const textId = textMan.originalID();

  const result = mode === 'engrave' ? modelMan.subtract(textMan) : modelMan.add(textMan);
  const mesh = result.getMesh();

  // expand indexed result -> soup + per-triangle isText via run origin
  const triVerts = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp;
  const triCount = triVerts.length / 3;
  const positions = new Float32Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = triVerts[t * 3 + k];
      positions[t * 9 + k * 3] = vp[vi * np];
      positions[t * 9 + k * 3 + 1] = vp[vi * np + 1];
      positions[t * 9 + k * 3 + 2] = vp[vi * np + 2];
    }
  }
  const isText = new Uint8Array(triCount);
  const runIndex = mesh.runIndex, runOriginalID = mesh.runOriginalID;
  if (runIndex && runOriginalID) {
    for (let r = 0; r < runOriginalID.length; r++) {
      if (runOriginalID[r] !== textId) continue;
      const from = runIndex[r] / 3, to = runIndex[r + 1] / 3;
      for (let t = from; t < to; t++) isText[t] = 1;
    }
  }
  modelMan.delete?.(); textMan.delete?.(); result.delete?.();
  return { positions, isText, filledLoops: rep.filledLoops, modelId, textId };
}
