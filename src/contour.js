/**
 * Contour cutting — split the mesh exactly along the boundaries of a label
 * field instead of painting whole triangles.
 *
 * Painting per triangle (even after subdivision) leaves a sawtooth of slivers
 * along every edge, worst on irregular organic meshes. Here each region of an
 * image or glyph mask gets a distance field (distance from every pixel to the
 * nearest boundary). Every mesh vertex samples it; wherever an edge's two
 * ends fall in different regions, a vertex is inserted where the boundary
 * actually crosses that edge (linear interpolation of the distances), and the
 * triangles are split along it. The painted edge then follows the true
 * outline with sub-triangle precision — smooth curves, no spikes.
 *
 * Cut points are computed once per (welded) edge from its two endpoints, so
 * both triangles sharing an edge split at the same point: no T-junctions, the
 * mesh stays watertight for export.
 */

// ---------- 2D distance fields ----------

const INF = 1e20;

/** Exact 1D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Euclidean distance (in pixels) from every pixel to the nearest seed pixel. */
export function distanceTransform(seed, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n);
  const v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = seed[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
  }
  return out;
}

/**
 * For a label image, each pixel's distance to its own region's boundary:
 * distance to the nearest pixel of a different label, minus half a pixel
 * (the boundary sits between pixel centers).
 */
export function labelDistance(labels, w, h) {
  const out = new Float32Array(w * h).fill(1e6);
  const seed = new Uint8Array(w * h);
  for (const L of new Set(labels)) {
    let any = false;
    for (let i = 0; i < w * h; i++) {
      const s = labels[i] !== L ? 1 : 0;
      seed[i] = s;
      any = any || s === 1;
    }
    if (!any) continue; // one label everywhere: no boundary
    const d = distanceTransform(seed, w, h);
    for (let i = 0; i < w * h; i++) if (labels[i] === L) out[i] = d[i] - 0.5;
  }
  return out;
}

/** Surround a label image with a 1px border of `outside` so regions touching
 *  the edge get a real boundary there. */
export function padLabels(labels, w, h, outside = -1) {
  const pw = w + 2, ph = h + 2;
  const out = new Int16Array(pw * ph).fill(outside);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[(y + 1) * pw + x + 1] = labels[y * w + x];
  }
  return { labels: out, w: pw, h: ph };
}

/** One 3x3 majority (mode) pass — clears single-pixel speckle from a
 *  palette-snapped photo/logo without moving clean edges. */
export function majorityFilter(labels, w, h) {
  const out = new Int16Array(labels);
  const counts = new Map();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      counts.clear();
      let best = labels[y * w + x], bestN = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const L = labels[(y + dy) * w + x + dx];
          const c = (counts.get(L) || 0) + 1;
          counts.set(L, c);
          if (c > bestN) { bestN = c; best = L; }
        }
      }
      if (bestN >= 5) out[y * w + x] = best;
    }
  }
  return out;
}

/**
 * Sampler over a (padded) label image and its labelDistance map. At
 * continuous pixel coords (pixel centers at i+0.5) it returns the region label
 * and a sub-pixel distance to that region's boundary: bilinear interpolation
 * of the distance signed relative to the chosen label. Outside the image the
 * label is `outside`. Returns a shared { label, dist } object — read it
 * before the next call.
 */
export function makeLabelSampler(labels, dist, w, h, outside = -1) {
  const out = { label: outside, dist: 0 };
  return (x, y) => {
    const cx = Math.min(w - 0.5, Math.max(0.5, x));
    const cy = Math.min(h - 0.5, Math.max(0.5, y));
    const off = Math.hypot(x - cx, y - cy);
    const ix = Math.min(w - 1, Math.floor(cx)), iy = Math.min(h - 1, Math.floor(cy));
    if (off > 0) {
      // beyond the (outside-labelled) padding: distance runs on past the edge
      out.label = outside;
      out.dist = off + Math.max(0, dist[iy * w + ix]);
      return out;
    }
    const L = labels[iy * w + ix];
    const fx = cx - 0.5, fy = cy - 0.5;
    const x0 = Math.max(0, Math.min(w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const s = (i) => (labels[i] === L ? dist[i] : -dist[i]);
    const i00 = y0 * w + x0;
    const val = (s(i00) * (1 - tx) + s(i00 + 1) * tx) * (1 - ty) +
                (s(i00 + w) * (1 - tx) + s(i00 + w + 1) * tx) * ty;
    out.label = L;
    out.dist = Math.max(val, 0.02); // the nearest pixel decides; never zero
    return out;
  };
}

// ---------- mesh cutting ----------

// keep cut points off the vertices so no zero-area slivers are created
const T_MIN = 0.03, T_MAX = 1 - T_MIN;

/**
 * Split triangles along the zero-crossings of a label field.
 *
 * field(x, y, z, nx, ny, nz) → { label, dist } (may be a shared object):
 *   label = region (group index, or -1 for "no effect"), dist = distance to
 *   the region boundary (any consistent unit). Evaluated once per welded
 *   vertex, with the normal of the first in-scope triangle that touches it.
 * opts.triInScope(pos, o) — which triangles to evaluate/cut (default: all).
 *
 * Returns { positions, triGroup, blocked, labels } where labels[t] is the
 * field region of each output triangle (-1 = untouched / out of scope);
 * triGroup/blocked carry each piece's parent values.
 */
export async function cutAlongField(positions, triGroup, blocked, field, opts = {}) {
  const pos = positions;
  const triCount = pos.length / 9;
  const onProgress = opts.onProgress;
  const tick = async (i, n, base, span) => {
    if ((i & 0x7fff) === 0 && i > 0) {
      onProgress?.(base + span * (i / n), 'cutting');
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  // weld vertices so shared edges get one cut point
  const vertId = new Int32Array(triCount * 3);
  const seen = new Map();
  const vPos = [];
  for (let i = 0; i < triCount * 3; i++) {
    await tick(i, triCount * 3, 0, 0.3);
    const key = pos[i * 3] + '_' + pos[i * 3 + 1] + '_' + pos[i * 3 + 2];
    let id = seen.get(key);
    if (id === undefined) {
      id = vPos.length / 3;
      seen.set(key, id);
      vPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    vertId[i] = id;
  }
  const nVerts = vPos.length / 3;
  const NONE = -32768;
  const vLabel = new Int32Array(nVerts).fill(NONE);
  const vDist = new Float32Array(nVerts);

  // evaluate the field at the vertices of in-scope triangles
  const inScope = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    await tick(t, triCount, 0.3, 0.3);
    const o = t * 9;
    if (opts.triInScope && !opts.triInScope(pos, o)) continue;
    inScope[t] = 1;
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const wx = pos[o + 6] - pos[o], wy = pos[o + 7] - pos[o + 1], wz = pos[o + 8] - pos[o + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    for (let k = 0; k < 3; k++) {
      const vid = vertId[t * 3 + k];
      if (vLabel[vid] !== NONE) continue;
      const r = field(vPos[vid * 3], vPos[vid * 3 + 1], vPos[vid * 3 + 2], nx, ny, nz);
      vLabel[vid] = r.label;
      vDist[vid] = Math.max(r.dist, 1e-6);
    }
  }

  // one cut point per edge whose ends lie in different regions
  const cuts = new Map();
  const cutPoint = (a, b) => {
    if (vLabel[a] === NONE || vLabel[b] === NONE || vLabel[a] === vLabel[b]) return null;
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const key = lo * nVerts + hi;
    let c = cuts.get(key);
    if (!c) {
      // canonical direction (lo → hi) so both neighbors compute the same point
      const t = Math.min(T_MAX, Math.max(T_MIN, vDist[lo] / (vDist[lo] + vDist[hi])));
      c = [
        vPos[lo * 3] + (vPos[hi * 3] - vPos[lo * 3]) * t,
        vPos[lo * 3 + 1] + (vPos[hi * 3 + 1] - vPos[lo * 3 + 1]) * t,
        vPos[lo * 3 + 2] + (vPos[hi * 3 + 2] - vPos[lo * 3 + 2]) * t,
      ];
      cuts.set(key, c);
    }
    return c;
  };

  const outPos = [], outGroup = [], outBlock = [], outLabel = [];
  for (let t = 0; t < triCount; t++) {
    await tick(t, triCount, 0.6, 0.4);
    const o = t * 9;
    const g = triGroup[t], bl = blocked[t];
    const id = [vertId[t * 3], vertId[t * 3 + 1], vertId[t * 3 + 2]];
    const V = [
      [pos[o], pos[o + 1], pos[o + 2]],
      [pos[o + 3], pos[o + 4], pos[o + 5]],
      [pos[o + 6], pos[o + 7], pos[o + 8]],
    ];
    const C = [cutPoint(id[0], id[1]), cutPoint(id[1], id[2]), cutPoint(id[2], id[0])];
    const emit = (a, b, c, label) => {
      outPos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      outGroup.push(g);
      outBlock.push(bl);
      outLabel.push(label);
    };
    const nCuts = (C[0] ? 1 : 0) + (C[1] ? 1 : 0) + (C[2] ? 1 : 0);

    if (inScope[t]) {
      const L = [vLabel[id[0]], vLabel[id[1]], vLabel[id[2]]];
      if (nCuts === 0) {
        emit(V[0], V[1], V[2], L[0]);
      } else if (nCuts === 3) {
        // three regions meet: fan around the cut points' center
        const q = [
          (C[0][0] + C[1][0] + C[2][0]) / 3,
          (C[0][1] + C[1][1] + C[2][1]) / 3,
          (C[0][2] + C[1][2] + C[2][2]) / 3,
        ];
        emit(V[0], C[0], q, L[0]); emit(V[0], q, C[2], L[0]);
        emit(V[1], C[1], q, L[1]); emit(V[1], q, C[0], L[1]);
        emit(V[2], C[2], q, L[2]); emit(V[2], q, C[1], L[2]);
      } else {
        // two regions: the odd vertex A is cut off by the segment AB–CA
        const r = !C[1] ? 0 : !C[2] ? 1 : 2; // r = odd vertex (its opposite edge is uncut)
        const A = V[r], B = V[(r + 1) % 3], Cc = V[(r + 2) % 3];
        const cAB = C[r], cCA = C[(r + 2) % 3];
        emit(A, cAB, cCA, L[r]);
        const lb = L[(r + 1) % 3];
        // split the remaining quad along its shorter diagonal
        const d1 = (cAB[0] - Cc[0]) ** 2 + (cAB[1] - Cc[1]) ** 2 + (cAB[2] - Cc[2]) ** 2;
        const d2 = (B[0] - cCA[0]) ** 2 + (B[1] - cCA[1]) ** 2 + (B[2] - cCA[2]) ** 2;
        if (d1 <= d2) { emit(cAB, B, Cc, lb); emit(cAB, Cc, cCA, lb); }
        else { emit(cAB, B, cCA, lb); emit(B, Cc, cCA, lb); }
      }
      continue;
    }

    // out of scope but sharing a cut edge with a cut neighbor: split
    // geometrically at the same points (keeps the mesh stitched), no paint
    if (nCuts === 0) {
      emit(V[0], V[1], V[2], -1);
    } else if (nCuts === 3) {
      emit(V[0], C[0], C[2], -1); emit(C[0], V[1], C[1], -1);
      emit(C[2], C[1], V[2], -1); emit(C[0], C[1], C[2], -1);
    } else {
      const r = C[0] ? 0 : C[1] ? 1 : 2; // first cut edge (V[r]–V[r+1])
      const A = V[r], B = V[(r + 1) % 3], Cc = V[(r + 2) % 3];
      const m = C[r];
      if (nCuts === 1) {
        emit(A, m, Cc, -1); emit(m, B, Cc, -1);
      } else if (C[(r + 1) % 3]) {
        const mBC = C[(r + 1) % 3];
        emit(A, m, Cc, -1); emit(m, mBC, Cc, -1); emit(m, B, mBC, -1);
      } else {
        const mCA = C[(r + 2) % 3];
        emit(A, m, mCA, -1); emit(m, B, mCA, -1); emit(mCA, B, Cc, -1);
      }
    }
  }

  return {
    positions: new Float32Array(outPos),
    triGroup: Uint16Array.from(outGroup),
    blocked: Uint8Array.from(outBlock),
    labels: Int16Array.from(outLabel),
    cutEdges: cuts.size,
  };
}
