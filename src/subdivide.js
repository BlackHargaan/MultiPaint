/**
 * Conforming (red-green) mesh refinement along decal/stroke boundaries.
 *
 * Two phases:
 *  1. Size normalization — triangles whose bounds overlap the target region
 *     but are far larger than it (e.g. full-height lathe slivers on a
 *     cylinder) are split until their edges are at most opts.maxEdge. Point
 *     sampling can't detect a small decal crossing a huge triangle, so this
 *     runs first, purely geometrically.
 *  2. Boundary refinement — triangles whose corner/centroid classifications
 *     disagree get split, up to opts.maxRounds rounds.
 *
 * Edge marks are shared via welded edge keys and every triangle splits
 * according to its marked edges (1→2, 2→3, 3→4 children), so neighbors stay
 * stitched — no T-junctions, the mesh stays watertight.
 *
 * classify(x, y, z, nx, ny, nz) → group index, or -1 where there's no effect.
 * opts.inScope(x, y, z) — cheap point pre-test for phase 2.
 * opts.triInScope(pos, o) — triangle-level overlap test (9 floats at offset o)
 *   used by phase 1; falls back to corner/centroid inScope tests.
 * opts.maxEdge — phase 1 target edge length (skip phase 1 if absent).
 */
export async function refineMesh(positions, triGroup, blocked, classify, opts = {}) {
  const maxRounds = opts.maxRounds ?? 3;
  const minEdge = opts.minEdge ?? 0.3;
  const state = {
    pos: positions,
    groups: Array.from(triGroup),
    block: Array.from(blocked),
  };

  // phase 1: cut oversized in-scope triangles down to decal scale, so point
  // sampling can detect a small decal crossing a huge triangle
  if (opts.maxEdge) {
    for (let round = 0; round < 8; round++) {
      const marked = await runRound(state, (pos, t) => {
        const o = t * 9;
        if (longestEdge(pos, o) <= opts.maxEdge) return 0;
        return triangleInScope(pos, o, opts) ? 0b111 : 0;
      }, opts, round, 'sizing');
      if (!marked) break;
    }
  }

  // phase 2: refine along classification boundaries
  for (let round = 0; round < maxRounds; round++) {
    const marked = await runRound(state, (pos, t, ctx) => {
      const o = t * 9;
      if (longestEdge(pos, o) < minEdge) return 0;
      if (!triangleInScope(pos, o, opts)) return 0;
      const n = triNormal(pos, o);
      const s0 = ctx.classifyVert(t * 3, n);
      const s1 = ctx.classifyVert(t * 3 + 1, n);
      const s2 = ctx.classifyVert(t * 3 + 2, n);
      if (s0 === s1 && s1 === s2) {
        const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
        const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
        const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
        if (classify(cx, cy, cz, n[0], n[1], n[2]) === s0) return 0;
      }
      return 0b111;
    }, opts, round, 'refining', classify);
    if (!marked) break;
  }

  return {
    positions: state.pos,
    triGroup: Uint16Array.from(state.groups),
    blocked: Uint8Array.from(state.block),
    triCount: state.pos.length / 9,
  };
}

function longestEdge(pos, o) {
  const e0 = Math.hypot(pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]);
  const e1 = Math.hypot(pos[o + 6] - pos[o + 3], pos[o + 7] - pos[o + 4], pos[o + 8] - pos[o + 5]);
  const e2 = Math.hypot(pos[o] - pos[o + 6], pos[o + 1] - pos[o + 7], pos[o + 2] - pos[o + 8]);
  return Math.max(e0, e1, e2);
}

function triNormal(pos, o) {
  const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
  const wx = pos[o + 6] - pos[o], wy = pos[o + 7] - pos[o + 1], wz = pos[o + 8] - pos[o + 2];
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  return [nx / nl, ny / nl, nz / nl];
}

/** Triangle-level scope test: prefer the caller's overlap test (robust for
 *  huge triangles), else fall back to corner/centroid point tests. */
function triangleInScope(pos, o, opts) {
  if (opts.triInScope) return opts.triInScope(pos, o);
  if (!opts.inScope) return true;
  const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
  const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
  const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
  return opts.inScope(cx, cy, cz) ||
    opts.inScope(pos[o], pos[o + 1], pos[o + 2]) ||
    opts.inScope(pos[o + 3], pos[o + 4], pos[o + 5]) ||
    opts.inScope(pos[o + 6], pos[o + 7], pos[o + 8]);
}

/** One weld → mark → split round. Returns how many triangles were marked. */
async function runRound(state, shouldMark, opts, round, phase, classify) {
  const pos = state.pos;
  const triCount = pos.length / 9;
  const yieldEvery = 0x7fff;
  const onProgress = opts.onProgress;

  // weld vertices for shared edge keys
  const vertId = new Int32Array(triCount * 3);
  const seen = new Map();
  let nextId = 0;
  for (let i = 0; i < triCount * 3; i++) {
    if ((i & yieldEvery) === 0 && i > 0) {
      onProgress?.(0.3 * (i / (triCount * 3)), phase);
      await new Promise((r) => setTimeout(r, 0));
    }
    const key = pos[i * 3] + '_' + pos[i * 3 + 1] + '_' + pos[i * 3 + 2];
    let id = seen.get(key);
    if (id === undefined) seen.set(key, (id = nextId++));
    vertId[i] = id;
  }
  const edgeKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);

  // per-welded-vertex classification cache for phase 2
  const memo = classify ? new Int32Array(nextId).fill(-2) : null;
  const ctx = {
    classifyVert: (cornerIdx, n) => {
      const vid = vertId[cornerIdx];
      if (memo[vid] !== -2) return memo[vid];
      const c = classify(
        pos[cornerIdx * 3], pos[cornerIdx * 3 + 1], pos[cornerIdx * 3 + 2],
        n[0], n[1], n[2]
      );
      memo[vid] = c;
      return c;
    },
  };

  const splitEdges = new Set();
  let markedCount = 0;
  for (let t = 0; t < triCount; t++) {
    if ((t & yieldEvery) === 0 && t > 0) {
      onProgress?.(0.3 + 0.4 * (t / triCount), phase);
      await new Promise((r) => setTimeout(r, 0));
    }
    const bits = shouldMark(pos, t, ctx);
    if (!bits) continue;
    markedCount++;
    if (bits & 1) splitEdges.add(edgeKey(vertId[t * 3], vertId[t * 3 + 1]));
    if (bits & 2) splitEdges.add(edgeKey(vertId[t * 3 + 1], vertId[t * 3 + 2]));
    if (bits & 4) splitEdges.add(edgeKey(vertId[t * 3 + 2], vertId[t * 3]));
  }
  if (!markedCount) return 0;

  // rebuild soup, splitting every triangle by its marked edges
  const outPos = [];
  const outGroup = [];
  const outBlock = [];
  for (let t = 0; t < triCount; t++) {
    if ((t & yieldEvery) === 0 && t > 0) {
      onProgress?.(0.7 + 0.3 * (t / triCount), phase);
      await new Promise((r) => setTimeout(r, 0));
    }
    const o = t * 9;
    const g = state.groups[t], bl = state.block[t];
    const V = [
      [pos[o], pos[o + 1], pos[o + 2]],
      [pos[o + 3], pos[o + 4], pos[o + 5]],
      [pos[o + 6], pos[o + 7], pos[o + 8]],
    ];
    const marked = [
      splitEdges.has(edgeKey(vertId[t * 3], vertId[t * 3 + 1])),
      splitEdges.has(edgeKey(vertId[t * 3 + 1], vertId[t * 3 + 2])),
      splitEdges.has(edgeKey(vertId[t * 3 + 2], vertId[t * 3])),
    ];
    const nMarked = marked[0] + marked[1] + marked[2];
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const E = (a, b, c) => {
      outPos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      outGroup.push(g);
      outBlock.push(bl);
    };

    if (nMarked === 0) {
      E(V[0], V[1], V[2]);
    } else if (nMarked === 3) {
      const m0 = mid(V[0], V[1]), m1 = mid(V[1], V[2]), m2 = mid(V[2], V[0]);
      E(V[0], m0, m2); E(m0, V[1], m1); E(m2, m1, V[2]); E(m0, m1, m2);
    } else {
      // rotate so edge 0 (V[0]-V[1]) is marked
      const r = marked[0] ? 0 : marked[1] ? 1 : 2;
      const A = V[r], B = V[(r + 1) % 3], C = V[(r + 2) % 3];
      const mAB = mid(A, B);
      if (nMarked === 1) {
        E(A, mAB, C); E(mAB, B, C);
      } else if (marked[(r + 1) % 3]) {
        const mBC = mid(B, C);
        E(A, mAB, C); E(mAB, mBC, C); E(mAB, B, mBC);
      } else {
        const mCA = mid(C, A);
        E(A, mAB, mCA); E(mAB, B, mCA); E(mCA, B, C);
      }
    }
  }

  state.pos = new Float32Array(outPos);
  state.groups = outGroup;
  state.block = outBlock;
  return markedCount;
}
