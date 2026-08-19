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
