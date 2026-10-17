/**
 * Trace a binary glyph alpha-mask (from curvedtext.rasterizeGlyphs) into closed
 * lattice polygons — outer contours and holes together — so they can be
 * extruded into a 3D glyph solid. We reuse the SAME masks the painted text uses,
 * so emboss matches the on-screen font/bold/italic with no font-file plumbing.
 *
 * Boundary edges run along the pixel lattice (integer grid 0..w, 0..h), so every
 * loop is a simple rectilinear polygon — the safest possible input for a CSG
 * fill. At the target sizes (~160px mask -> a few mm) one pixel is well under
 * 0.05 mm, so the staircase is invisible; we only drop collinear points.
 *
 * Winding is left unspecified on purpose: the solids are built with an even-odd
 * fill rule, which resolves holes by nesting parity regardless of direction.
 */

const K = 100000; // lattice vertex key: x*K + y  (w,h << K)

/** Collect the unit boundary edges of the foreground, chain them into loops. */
export function traceMask(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  // adjacency between lattice vertices via boundary unit-edges
  const adj = new Map();
  const addEdge = (ax, ay, bx, by) => {
    const a = ax * K + ay, b = bx * K + by;
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x - 1, y)) addEdge(x, y, x, y + 1);       // left side
      if (!at(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right side
      if (!at(x, y - 1)) addEdge(x, y, x + 1, y);       // top side
      if (!at(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1); // bottom side
    }
  }

  // consume edges into closed loops; at a 4-way saddle vertex pick the next
  // edge by a consistent left-turn rule so loops never cross themselves
  const used = new Set();
  const edgeKey = (a, b) => (a < b ? a * 1e11 + b : b * 1e11 + a);
  const loops = [];
  const dirOf = (a, b) => { const bx = Math.floor(b / K), by = b % K, ax = Math.floor(a / K), ay = a % K; return bx > ax ? 0 : bx < ax ? 2 : by > ay ? 1 : 3; }; // 0 R,1 D,2 L,3 U

  for (const [startA, nbrs] of adj) {
    for (const startB of nbrs) {
      if (used.has(edgeKey(startA, startB))) continue;
      const loop = [startA];
      let prev = startA, cur = startB;
      used.add(edgeKey(startA, startB));
      let guard = 0;
      while (cur !== startA && guard++ < 1e7) {
        loop.push(cur);
        const options = adj.get(cur).filter((n) => !used.has(edgeKey(cur, n)));
        if (!options.length) break;
        const inDir = dirOf(prev, cur);
        // prefer: left turn, straight, right turn, back — keeps loops simple
        const pref = [(inDir + 3) % 4, inDir, (inDir + 1) % 4, (inDir + 2) % 4];
        let next = options[0];
        for (const p of pref) { const o = options.find((n) => dirOf(cur, n) === p); if (o !== undefined) { next = o; break; } }
        used.add(edgeKey(cur, next));
        prev = cur; cur = next;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }

  // lattice keys -> points, drop collinear runs, then simplify the staircase.
  // One pixel is well under 0.1 mm at real sizes, so an epsilon of ~1.2 px
  // collapses the stair steps into clean edges with no visible change while
  // cutting the glyph solid's triangle count by roughly an order of magnitude.
  const EPS_PX = 1.2;
  return loops.map((loop) => {
    const pts = loop.map((k) => [Math.floor(k / K), k % K]);
    const corners = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) !== 0) corners.push(b);
    }
    return corners.length > 3 ? simplifyClosed(corners, EPS_PX) : corners;
  }).filter((l) => l.length >= 3);
}

/** Ramer–Douglas–Peucker on a closed polygon (split at the two extreme points). */
function simplifyClosed(pts, eps) {
  const n = pts.length;
  // farthest pair of indices to seed the two open chains
  let i0 = 0, i1 = 1, best = -1;
  for (let i = 0; i < n; i++) {
    const dx = pts[i][0] - pts[0][0], dy = pts[i][1] - pts[0][1];
    const d = dx * dx + dy * dy;
    if (d > best) { best = d; i1 = i; }
  }
  const chain = (a, b) => { // indices a..b inclusive along the ring
    const seq = []; for (let i = a; ; i = (i + 1) % n) { seq.push(pts[i]); if (i === b) break; }
    return rdp(seq, eps);
  };
  const first = chain(i0, i1), second = chain(i1, i0);
  const out = first.slice(0, -1).concat(second.slice(0, -1)); // drop shared endpoints
  return out.length >= 3 ? out : pts;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let idx = -1, max = 0;
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [a, b];
  const left = rdp(pts.slice(0, idx + 1), eps);
  const right = rdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}
