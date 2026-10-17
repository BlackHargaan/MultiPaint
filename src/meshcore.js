/**
 * Pure per-triangle mesh caches over a non-indexed position array (Float32Array
 * of triCount*9 floats). No THREE dependency, so this runs unchanged on the
 * main thread or inside a Web Worker.
 */

/**
 * Triangle adjacency by welding vertices on exact coordinates (STL repeats
 * identical floats for shared vertices). Int32Array of 3 neighbor triangle
 * indices per triangle, -1 where an edge has no neighbor.
 */
export function buildAdjacency(positions) {
  const vertCount = positions.length / 3;
  const triCount = vertCount / 3;
  const adjacency = new Int32Array(triCount * 3).fill(-1);

  const vertId = new Int32Array(vertCount);
  const seen = new Map();
  let nextId = 0;
  for (let i = 0; i < vertCount; i++) {
    const o = i * 3;
    const key = positions[o] + '_' + positions[o + 1] + '_' + positions[o + 2];
    let id = seen.get(key);
    if (id === undefined) { id = nextId++; seen.set(key, id); }
    vertId[i] = id;
  }

  const edges = new Map();
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vertId[t * 3 + e];
      const b = vertId[t * 3 + ((e + 1) % 3)];
      const key = a < b ? a + '_' + b : b + '_' + a;
      const other = edges.get(key);
      if (other === undefined) {
        edges.set(key, t * 3 + e);
      } else {
        adjacency[t * 3 + e] = (other / 3) | 0;
        adjacency[other] = t;
        edges.delete(key); // manifold assumption: an edge joins at most 2 tris
      }
    }
  }
  return adjacency;
}

/** Unit face normal per triangle (Float32Array, 3 per triangle). */
export function computeTriNormals(positions) {
  const triCount = positions.length / 9;
  const normals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3] - ax, by = positions[o + 4] - ay, bz = positions[o + 5] - az;
    const cx = positions[o + 6] - ax, cy = positions[o + 7] - ay, cz = positions[o + 8] - az;
    let nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / len;
    normals[t * 3 + 1] = ny / len;
    normals[t * 3 + 2] = nz / len;
  }
  return normals;
}

/** Centroid per triangle (Float32Array, 3 per triangle). */
export function computeTriCentroids(positions) {
  const triCount = positions.length / 9;
  const cen = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    cen[t * 3] = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    cen[t * 3 + 1] = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    cen[t * 3 + 2] = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
  }
  return cen;
}

/** All three caches for a position array. */
export function buildMeshCachesFromPositions(positions) {
  return {
    triCount: positions.length / 9,
    adjacency: buildAdjacency(positions),
    triNormals: computeTriNormals(positions),
    triCentroids: computeTriCentroids(positions),
  };
}

/**
 * Make every shell's winding consistent and outward-facing, in place.
 *
 * STLs from some exporters come out inside-out (every normal pointing in) or
 * with patches of faces wound backwards. Front-face raycasting then hits the
 * FAR side of the model, so brushes, fills, decals and text land on the wrong
 * side. Two levels:
 *
 *  1. Consistency, per orientation group (faces joined by clean two-face
 *     edges): a neighbor that runs the shared edge in the SAME direction is
 *     wound backwards relative to us. Whichever orientation flips the fewest
 *     faces wins, so the result doesn't depend on where the walk starts.
 *     Non-manifold edges (3+ faces) pair faces arbitrarily, so no orientation
 *     is inferred across them.
 *  2. Outward, per connected shell (faces joined by ANY shared edge): a shell
 *     whose signed volume is negative is inside-out and is flipped whole.
 *     Effectively closed shells (≤2% open edges) trust the sign; genuinely
 *     open ones (a cup with no bottom) flip only on strong evidence, so a flat
 *     or ambiguous open surface is never flipped by mistake. Debris shells
 *     with negligible area are left as found.
 *
 * Flipping swaps a triangle's 2nd and 3rd vertices, so per-triangle data
 * (paint, blockers) keeps its index. Returns
 * { facesFlipped, shellsInverted, facesReoriented, shells }.
 */
export function orientShells(positions) {
  const vertCount = positions.length / 3;
  const triCount = vertCount / 3;
  const stats = { facesFlipped: 0, shellsInverted: 0, facesReoriented: 0, shells: 0 };
  if (!triCount) return stats;

  // weld on exact coordinates, as buildAdjacency does
  const vertId = new Int32Array(vertCount);
  const seen = new Map();
  let nextId = 0;
  for (let i = 0; i < vertCount; i++) {
    const o = i * 3;
    const key = positions[o] + '_' + positions[o + 1] + '_' + positions[o + 2];
    let id = seen.get(key);
    if (id === undefined) { id = nextId++; seen.set(key, id); }
    vertId[i] = id;
  }

  // shells: union-find over triangles sharing any edge
  const parent = new Int32Array(triCount);
  for (let t = 0; t < triCount; t++) parent[t] = t;
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };

  // nb/same: manifold links only (neighbor across edge e, and whether it runs
  // the shared edge in the same direction)
  const nb = new Int32Array(triCount * 3).fill(-1);
  const same = new Uint8Array(triCount * 3);
  const edges = new Map(); // key → [uses…] (more than 2 = non-manifold)
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vertId[t * 3 + e];
      const b = vertId[t * 3 + ((e + 1) % 3)];
      if (a === b) continue; // degenerate edge
      const key = a < b ? a + '_' + b : b + '_' + a;
      const here = t * 3 + e;
      const uses = edges.get(key);
      if (uses === undefined) { edges.set(key, [here]); continue; }
      const first = uses[0];
      const ra = find((first / 3) | 0), rb = find(t);
      if (ra !== rb) parent[ra] = rb;
      if (uses.length === 1) {
        const ot = (first / 3) | 0;
        const s = vertId[ot * 3 + (first % 3)] === a ? 1 : 0; // same start → same direction
        nb[here] = ot; same[here] = s;
        nb[first] = t; same[first] = s;
      } else if (uses.length === 2) {
        nb[uses[0]] = -1; nb[uses[1]] = -1; // 3rd use: undo the arbitrary pairing
      }
      uses.push(here);
    }
  }
  const openEdges = new Int32Array(triCount); // edges used by this triangle only
  for (const uses of edges.values()) if (uses.length === 1) openEdges[(uses[0] / 3) | 0]++;

  // 1. consistency within each orientation group
  const flip = new Uint8Array(triCount);
  const visited = new Uint8Array(triCount);
  const stack = [];
  const group = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (visited[seed]) continue;
    group.length = 0;
    visited[seed] = 1;
    stack.push(seed);
    while (stack.length) {
      const t = stack.pop();
      group.push(t);
      for (let e = 0; e < 3; e++) {
        const n = nb[t * 3 + e];
        if (n < 0 || visited[n]) continue; // conflicts (non-orientable) left as found
        visited[n] = 1;
        flip[n] = flip[t] ^ same[t * 3 + e];
        stack.push(n);
      }
    }
    let flipped = 0;
    for (const t of group) flipped += flip[t];
    if (flipped * 2 > group.length) for (const t of group) flip[t] ^= 1;
  }

  // 2. outward per shell
  const triArea = (t) => {
    const o = t * 9;
    const ux = positions[o + 3] - positions[o], uy = positions[o + 4] - positions[o + 1], uz = positions[o + 5] - positions[o + 2];
    const wx = positions[o + 6] - positions[o], wy = positions[o + 7] - positions[o + 1], wz = positions[o + 8] - positions[o + 2];
    return Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
  };
  const shells = new Map(); // root → triangle list
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let list = shells.get(r);
    if (!list) { list = []; shells.set(r, list); }
    list.push(t);
    totalArea += triArea(t);
  }
  // slivers/debris this small can't affect picking or printing — leave them
  const minShellArea = totalArea * 1e-4;

  for (const comp of shells.values()) {
    let area = 0, open = 0, cx = 0, cy = 0, cz = 0;
    for (const t of comp) {
      area += triArea(t);
      open += openEdges[t];
      const o = t * 9;
      cx += positions[o] + positions[o + 3] + positions[o + 6];
      cy += positions[o + 1] + positions[o + 4] + positions[o + 7];
      cz += positions[o + 2] + positions[o + 5] + positions[o + 8];
    }
    if (area < minShellArea) {
      for (const t of comp) flip[t] = 0;
      continue;
    }
    stats.shells++;
    const k = comp.length * 3;
    cx /= k; cy /= k; cz /= k;
    // signed volume about the shell's own centroid, consistency flips applied
    let vol = 0, absVol = 0;
    for (const t of comp) {
      const o = t * 9;
      const i1 = flip[t] ? 6 : 3, i2 = flip[t] ? 3 : 6;
      const ax = positions[o] - cx, ay = positions[o + 1] - cy, az = positions[o + 2] - cz;
      const bx = positions[o + i1] - cx, by = positions[o + i1 + 1] - cy, bz = positions[o + i1 + 2] - cz;
      const dx = positions[o + i2] - cx, dy = positions[o + i2 + 1] - cy, dz = positions[o + i2 + 2] - cz;
      const v = ax * (by * dz - bz * dy) - ay * (bx * dz - bz * dx) + az * (bx * dy - by * dx);
      vol += v;
      absVol += Math.abs(v);
    }
    const closed = open <= 0.02 * comp.length * 3;
    const inverted = absVol > 0 && vol < 0 && -vol > (closed ? 0.01 : 0.5) * absVol;
    let reoriented = 0;
    for (const t of comp) reoriented += flip[t];
    if (inverted) {
      for (const t of comp) flip[t] ^= 1;
      stats.shellsInverted++;
    }
    stats.facesReoriented += reoriented; // locally backwards faces, either way
  }

  // apply: swap vertices 2 and 3 of every flipped triangle
  for (let t = 0; t < triCount; t++) {
    if (!flip[t]) continue;
    stats.facesFlipped++;
    const o = t * 9;
    for (let j = 0; j < 3; j++) {
      const tmp = positions[o + 3 + j];
      positions[o + 3 + j] = positions[o + 6 + j];
      positions[o + 6 + j] = tmp;
    }
  }
  return stats;
}
