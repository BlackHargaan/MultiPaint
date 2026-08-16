import * as THREE from 'three';

/**
 * Per-glyph "use surface" text: each glyph is rasterized to its own mask and
 * placed on the surface with its own tangent frame (anchor P, in-plane axes
 * T/B, normal N), so a word wraps around a curved surface (mug, cooler)
 * undistorted instead of projecting through one flat plane. The result is a
 * classify()/inScope() set that drives painter.applyRegionPaint (paint +
 * optional conforming subdivision for crisp letters on coarse/lathe meshes).
 */

const GENERIC_FONTS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];

/** CSS font-family token: generics bare, everything else quoted. */
export function cssFontFamily(family) {
  return GENERIC_FONTS.includes(family) ? family : JSON.stringify(family);
}

/**
 * Rasterize each character to its own alpha mask. Spaces render nothing but
 * still advance. Returns glyphs (mask + pixel box + advance) plus the shared
 * line height in px, so physical sizing is one pxPerMm factor away.
 */
export function rasterizeGlyphs(text, { family, bold, italic }) {
  const fontPx = 160;
  const lineHpx = Math.ceil(fontPx * 1.28);
  const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontPx}px ${cssFontFamily(family)}`;
  const glyphs = [];
  for (const ch of [...text]) {
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const advancePx = Math.max(1, meas.measureText(ch).width);
    if (ch === ' ' || ch.trim() === '') {
      glyphs.push({ mask: null, w: 0, h: 0, advancePx });
      continue;
    }
    const w = Math.ceil(advancePx);
    const h = lineHpx;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(ch, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    glyphs.push({ mask, w, h, advancePx });
  }
  return { glyphs, lineHpx };
}

/** Cumulative arc length of a polyline; returns { cum, total }. */
function arcLengths(drape) {
  const cum = [0];
  for (let i = 1; i < drape.length; i++) cum.push(cum[i - 1] + drape[i].distanceTo(drape[i - 1]));
  return { cum, total: cum[cum.length - 1] };
}

/** World position + forward tangent at arc length s along the drape (extends
 *  past either end along the end tangents so long text still lands). */
function sampleDrape(drape, cum, s) {
  const last = drape.length - 1;
  if (s <= 0) {
    const T = new THREE.Vector3().subVectors(drape[1] ?? drape[0], drape[0]);
    if (T.lengthSq() < 1e-12) T.set(1, 0, 0);
    return { P: drape[0].clone().addScaledVector(T.clone().normalize(), s), T: T.normalize() };
  }
  if (s >= cum[last]) {
    const T = new THREE.Vector3().subVectors(drape[last], drape[last - 1] ?? drape[last]);
    if (T.lengthSq() < 1e-12) T.set(1, 0, 0);
    T.normalize();
    return { P: drape[last].clone().addScaledVector(T, s - cum[last]), T };
  }
  let i = 0;
  while (i < last && cum[i + 1] < s) i++;
  const segLen = cum[i + 1] - cum[i] || 1;
  const f = (s - cum[i]) / segLen;
  const P = new THREE.Vector3().lerpVectors(drape[i], drape[i + 1], f);
  const T = new THREE.Vector3().subVectors(drape[i + 1], drape[i]).normalize();
  return { P, T };
}

/** Map a BVH closestPointToPoint faceIndex back to original triangle order. */
function origFace(geometry, faceIndex) {
  const index = geometry.index;
  return index ? index.getX(faceIndex * 3) / 3 : faceIndex;
}

/** Total advance width of the text in mm at the given cap height, including
 *  charGapMm of extra spacing between each pair of glyphs. */
export function glyphsTotalMm(glyphs, heightMm, charGapMm = 0) {
  const pxPerMm = glyphs.lineHpx / heightMm;
  let px = 0;
  for (const g of glyphs.glyphs) px += g.advancePx;
  return px / pxPerMm + charGapMm * Math.max(0, glyphs.glyphs.length - 1);
}

/**
 * Build a level baseline that wraps around the model from a single anchor
 * click — the Orca "use surface" model, not a geodesic between two points. At
 * every step the advance direction is the horizontal surface tangent
 * (perpendicular to world up and the surface normal), rotated in-plane by
 * rotationDeg, so on a cylinder or cone the text stays level and reads upright
 * instead of drifting/tilting along a geodesic. Returns a surface polyline
 * (arc-length ~ds spacing) centered on the anchor per `alignment`.
 */
export function buildLevelBaseline(mesh, triNormals, anchor, opts = {}) {
  const { rotationDeg = 0, lengthMm, alignment = 'center' } = opts;
  const bvh = mesh.geometry.boundsTree;
  const up = new THREE.Vector3(0, 0, 1);
  const theta = rotationDeg * Math.PI / 180;
  const ds = opts.dsMm ?? Math.max(0.4, lengthMm / 80);

  const frameAt = (P) => {
    const t = {};
    bvh.closestPointToPoint(P, t);
    const face = origFace(mesh.geometry, t.faceIndex ?? 0);
    const N = new THREE.Vector3(triNormals[face * 3], triNormals[face * 3 + 1], triNormals[face * 3 + 2]);
    return { P: (t.point ? t.point.clone() : P.clone()), N };
  };
  // horizontal (level) surface tangent, rotated in-plane by theta, oriented so
  // the glyph "up" (N x dir) points toward world up — text reads upright
  const dirAt = (N) => {
    const h = new THREE.Vector3().crossVectors(up, N);
    if (h.lengthSq() < 1e-8) h.set(1, 0, 0); // N ∥ up (a cap) — arbitrary level dir
    h.normalize();
    if (theta) h.applyAxisAngle(N, theta);
    if (new THREE.Vector3().crossVectors(N, h).dot(up) < 0) h.negate();
    return h.normalize();
  };
  // walk the surface a distance L from the anchor, re-leveling each step
  const march = (L, sign) => {
    const pts = [];
    let cur = frameAt(anchor.point);
    for (let dist = 0; dist < L; dist += ds) {
      const dir = dirAt(cur.N).multiplyScalar(sign);
      cur = frameAt(cur.P.clone().addScaledVector(dir, ds));
      pts.push(cur.P.clone());
    }
    return pts;
  };

  const anchorP = frameAt(anchor.point).P;
  let leftLen, rightLen;
  if (alignment === 'left') { leftLen = 0; rightLen = lengthMm; }
  else if (alignment === 'right') { leftLen = lengthMm; rightLen = 0; }
  else { leftLen = lengthMm / 2; rightLen = lengthMm / 2; }
  const left = march(leftLen, -1).reverse();
  const right = march(rightLen, 1);
  return [...left, anchorP.clone(), ...right];
}

/**
 * Place glyphs along the drape. heightMm sets the cap/line height in mm; the
 * text starts at the drape origin and advances by each glyph's width. Each
 * placement carries its surface-snapped anchor and an orthonormal (T,B,N).
 */
export function buildPlacements(glyphs, drape, heightMm, mesh, triNormals, opts = {}) {
  const charGapMm = opts.charGapMm ?? 0;
  const { cum } = arcLengths(drape);
  const bvh = mesh.geometry.boundsTree;
  const pxPerMm = glyphs.lineHpx / heightMm;
  const placements = [];
  let advMm = 0;
  const target = {};
  const list = glyphs.glyphs;
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi];
    const wMm = g.advancePx / pxPerMm;
    if (g.mask) {
      const sCenter = advMm + wMm / 2;
      const { P: P0, T: T0 } = sampleDrape(drape, cum, sCenter);
      bvh.closestPointToPoint(P0, target);
      const face = origFace(mesh.geometry, target.faceIndex ?? 0);
      const N = new THREE.Vector3(triNormals[face * 3], triNormals[face * 3 + 1], triNormals[face * 3 + 2]);
      // orthonormalize the advance tangent against the surface normal
      const T = T0.clone().addScaledVector(N, -T0.dot(N));
      if (T.lengthSq() < 1e-9) T.copy(new THREE.Vector3(1, 0, 0).addScaledVector(N, -N.x));
      T.normalize();
      const B = new THREE.Vector3().crossVectors(N, T).normalize();
      const P = target.point ? target.point.clone() : P0;
      placements.push({
        P, N, T, B,
        halfW: wMm / 2,
        halfH: heightMm / 2,
        mask: g.mask, w: g.w, h: g.h,
      });
    }
    advMm += wMm + (gi < list.length - 1 ? charGapMm : 0);
  }
  return placements;
}

/**
 * Build the classify/inScope set for painter.applyRegionPaint. classify
 * returns `group` for a point that lands on an opaque glyph pixel on the
 * front-facing local surface patch, else -1. band is the max depth (mm) a
 * point may sit off a glyph's tangent plane and still count.
 */
export function buildTextClassifier(placements, group, heightMm) {
  const band = heightMm * 0.6;
  const spheres = placements.map((p) => ({ p, r: Math.hypot(p.halfW, p.halfH) + band }));

  const classify = (x, y, z, nx, ny, nz) => {
    for (const g of placements) {
      const dx = x - g.P.x, dy = y - g.P.y, dz = z - g.P.z;
      const h = dx * g.N.x + dy * g.N.y + dz * g.N.z;
      if (h > band || h < -band) continue;
      const u = dx * g.T.x + dy * g.T.y + dz * g.T.z;
      if (u > g.halfW || u < -g.halfW) continue;
      const w = dx * g.B.x + dy * g.B.y + dz * g.B.z;
      if (w > g.halfH || w < -g.halfH) continue;
      // must face roughly along the glyph normal (skip the far/back side)
      if (nx * g.N.x + ny * g.N.y + nz * g.N.z <= 0) continue;
      const px = Math.floor((u / (2 * g.halfW) + 0.5) * g.w);
      const py = Math.floor((0.5 - w / (2 * g.halfH)) * g.h);
      if (px < 0 || py < 0 || px >= g.w || py >= g.h) continue;
      if (g.mask[py * g.w + px]) return group;
    }
    return -1;
  };

  const inScope = (x, y, z) => {
    for (const s of spheres) {
      const dx = x - s.p.P.x, dy = y - s.p.P.y, dz = z - s.p.P.z;
      if (dx * dx + dy * dy + dz * dz <= s.r * s.r) return true;
    }
    return false;
  };

  // sphere vs triangle-AABB overlap (phase-1 sizing needs triangle-level scope)
  const triInScope = (pos, o) => {
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    for (const s of spheres) {
      const cx = Math.max(mnx, Math.min(s.p.P.x, mxx));
      const cy = Math.max(mny, Math.min(s.p.P.y, mxy));
      const cz = Math.max(mnz, Math.min(s.p.P.z, mxz));
      const dx = cx - s.p.P.x, dy = cy - s.p.P.y, dz = cz - s.p.P.z;
      if (dx * dx + dy * dy + dz * dz <= s.r * s.r) return true;
    }
    return false;
  };

  return { classify, inScope, triInScope, band };
}
