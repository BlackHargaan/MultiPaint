import * as THREE from 'three';
import { refineMesh } from './subdivide.js';

// ray length used for parallel (orthographic) occlusion rays, mm
const ORTHO_RAY = 2000;

function toHexColor(r, g, b) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/** True if the pixel sits on a color edge (anti-aliased blend) — such samples
 *  would pollute the auto-palette with mud colors. */
function isEdgePixel(pixels, ix, iy, w, h) {
  const i = (iy * w + ix) * 4;
  for (const [ox, oy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const nx = ix + ox, ny = iy + oy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
    const j = (ny * w + nx) * 4;
    if (Math.abs(pixels[i] - pixels[j]) + Math.abs(pixels[i + 1] - pixels[j + 1]) +
        Math.abs(pixels[i + 2] - pixels[j + 2]) > 100) return true;
  }
  return false;
}

/** True if two colors are brightness variants of the same saturated hue —
 *  i.e. one is the shaded version of the other. Neutrals (grays) are never
 *  merged this way, since white/gray/black are genuinely different filaments. */
function sameChroma(r1, g1, b1, r2, g2, b2) {
  const maxA = Math.max(r1, g1, b1), maxB = Math.max(r2, g2, b2);
  // a near-black pixel has no trustworthy hue (its ratios are compression
  // noise), so it must never claim to be the same chroma as a saturated
  // filament — that's what turned dark regions into colored confetti
  if (maxA < 50 || maxB < 50) return false;
  if ((maxA - Math.min(r1, g1, b1)) / maxA < 0.25) return false;
  if ((maxB - Math.min(r2, g2, b2)) / maxB < 0.25) return false;
  const la = Math.hypot(r1, g1, b1), lb = Math.hypot(r2, g2, b2);
  const dot = (r1 * r2 + g1 * g2 + b1 * b2) / (la * lb);
  return dot > 0.985; // within ~10° in RGB direction
}

// De-shading is opt-in (default off): it rescues saturated colors that were
// rendered dark, but also amplifies compression noise in dark regions into
// confetti, so it stays off unless the user asks for it.
let deshadeEnabled = false;
export function setDeshade(on) { deshadeEnabled = !!on; }

/**
 * Undo shading baked into an image (e.g. by an AI editor): saturated pixels
 * are brightened to a canonical value so "shaded red" reads as red instead of
 * near-black. Neutrals are untouched — white/gray/black filaments survive.
 * Mutates the RGBA array in place. No-op unless enabled via setDeshade().
 */
function deshadePixels(data) {
  if (!deshadeEnabled) return;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b);
    if (!max || max >= 110) continue; // only rescue truly shadow-dark pixels;
    // legitimate mid-tone colors must keep their identity (hue-aware matching
    // bridges the remaining brightness gap)
    if ((max - Math.min(r, g, b)) / max < 0.3) continue; // neutral — keep
    const k = 110 / max;
    data[i] = Math.min(255, Math.round(r * k));
    data[i + 1] = Math.min(255, Math.round(g * k));
    data[i + 2] = Math.min(255, Math.round(b * k));
  }
}

/**
 * Create new filament groups from sampled image colors (packed 0xRRGGBB).
 * Dominant colors become groups; colors close to an existing group (or a
 * brightness variant of one) reuse it. Respects the 16-slot slicer limit.
 * Returns how many groups were created. (Exported for tests.)
 */
export function createGroupsFromSamples(painter, samples) {
  const bins = new Map(); // 5-bit-per-channel bins -> accumulated sums
  for (const p of samples) {
    const key = (p & 0xf80000) | (p & 0x00f800) | (p & 0x0000f8);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b2: 0 }));
    b.n++;
    b.r += (p >> 16) & 255;
    b.g += (p >> 8) & 255;
    b.b2 += p & 255;
  }
  // cluster nearby bins so gradient shades pool their counts — a small
  // feature (e.g. a rainbow roof on a mostly-gray image) must still surface
  const clusters = [];
  for (const b of [...bins.values()].sort((a, b2) => b2.n - a.n)) {
    const r = b.r / b.n, g = b.g / b.n, bl = b.b2 / b.n;
    let target = null;
    for (const cl of clusters) {
      // distance to the cluster's SEED color (its dominant founding bin) —
      // comparing against a running mean lets the cluster drift along a
      // gradient and swallow every hue of a rainbow into one murky average
      if ((r - cl.sr) ** 2 + (g - cl.sg) ** 2 + (bl - cl.sb) ** 2 < 48 * 48) { target = cl; break; }
    }
    if (target) {
      target.n += b.n; target.r += b.r; target.g += b.g; target.b2 += b.b2;
    } else {
      clusters.push({ n: b.n, r: b.r, g: b.g, b2: b.b2, sr: r, sg: g, sb: bl });
    }
  }
  clusters.sort((a, b) => b.n - a.n);
  // absolute floor rather than a percentage: a small feature (logo, roof) on
  // a large model is still a legitimate color region
  const minCount = Math.max(10, samples.length * 0.001);
  const existing = painter.groups.map((g) => {
    const n = parseInt(g.color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  let created = 0;
  for (const b of clusters) {
    if (b.n < minCount || painter.groups.length >= 16) break;
    const r = Math.round(b.r / b.n), g = Math.round(b.g / b.n), bl = Math.round(b.b2 / b.n);
    let near = false;
    for (const c of existing) {
      if ((r - c[0]) ** 2 + (g - c[1]) ** 2 + (bl - c[2]) ** 2 < 34 * 34 ||
          sameChroma(r, g, bl, c[0], c[1], c[2])) { near = true; break; }
    }
    if (near) continue;
    painter.groups.push({ name: `Color ${painter.groups.length + 1}`, color: toHexColor(r, g, bl) });
    existing.push([r, g, bl]);
    created++;
  }
  return created;
}

/**
 * Image projection painting: capture a snapshot of the current view (freezing
 * the camera pose), let the user edit the image externally, then project the
 * edited colors back onto the mesh — only where triangles face the saved
 * camera and are not occluded.
 */
export class ProjectionSession {
  constructor() {
    this.data = null;
  }

  get active() {
    return this.data !== null;
  }

  clear() {
    this.data = null;
  }

  /** Render the current view flat-lit (pure filament colors, no shading —
   *  shadows would otherwise read as different colors on re-import), freeze
   *  the camera pose, and return a PNG blob. */
  capture(viewer) {
    const renderer = viewer.renderer;
    const canvas = renderer.domElement;
    const cursorVis = viewer.brushCursor.visible;
    const lineVis = viewer.lineGroup.visible;
    viewer.brushCursor.visible = false;
    viewer.lineGroup.visible = false;
    const origMat = viewer.mesh.material;
    const flatMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    viewer.mesh.material = flatMat;
    renderer.render(viewer.scene, viewer.camera);

    const w = canvas.width, h = canvas.height;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(canvas, 0, 0); // must happen in the same task as render()

    viewer.mesh.material = origMat;
    flatMat.dispose();
    viewer.brushCursor.visible = cursorVis;
    viewer.lineGroup.visible = lineVis;

    this.data = {
      width: w,
      height: h,
      camPos: viewer.camera.position.clone(),
      ortho: !viewer.camera.isPerspectiveCamera,
      forward: viewer.camera.getWorldDirection(new THREE.Vector3()),
      viewProj: new THREE.Matrix4().multiplyMatrices(
        viewer.camera.projectionMatrix,
        viewer.camera.matrixWorldInverse
      ),
      viewState: viewer.getViewState(),
      original: ctx.getImageData(0, 0, w, h),
    };
    return new Promise((resolve) => tmp.toBlob(resolve, 'image/png'));
  }

  /** Collect image colors under the decal (no occlusion/palette filtering) —
   *  used to auto-create filament groups before painting. */
  async _collectDecalSamples(painter, viewer, img, ov, onProgress) {
    const camera = viewer.camera;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const imgW = img.width, imgH = img.height;
    const tmp = document.createElement('canvas');
    tmp.width = imgW;
    tmp.height = imgH;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, imgW, imgH).data;
    deshadePixels(pixels);
    const camPos = camera.position;
    const isOrtho = !camera.isPerspectiveCamera;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const cos = Math.cos(ov.rotDeg * Math.PI / 180);
    const sin = Math.sin(ov.rotDeg * Math.PI / 180);
    const cen = painter.triCentroids, nor = painter.triNormals;
    const v = new THREE.Vector3(), dir = new THREE.Vector3();
    const samples = [];
    for (let t = 0; t < painter.triCount; t++) {
      if ((t & 0x7fff) === 0 && t > 0) {
        onProgress?.(0, 'reading image colors');
        await new Promise((r) => setTimeout(r, 0));
      }
      v.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]);
      if (isOrtho) dir.copy(fwd);
      else dir.copy(v).sub(camPos).normalize();
      if (nor[t * 3] * dir.x + nor[t * 3 + 1] * dir.y + nor[t * 3 + 2] * dir.z > -0.15) continue;
      const p = v.project(camera);
      if (p.z > 1) continue;
      const sx = (p.x + 1) / 2 * rect.width;
      const sy = (1 - p.y) / 2 * rect.height;
      const dx = sx - ov.cx, dy = sy - ov.cy;
      const lx = dx * cos + dy * sin + ov.w / 2;
      const ly = -dx * sin + dy * cos + ov.h / 2;
      if (lx < 0 || ly < 0 || lx >= ov.w || ly >= ov.h) continue;
      const ix = Math.min(imgW - 1, Math.max(0, Math.round(lx / ov.w * imgW)));
      const iy = Math.min(imgH - 1, Math.max(0, Math.round(ly / ov.h * imgH)));
      const i = (iy * imgW + ix) * 4;
      if (pixels[i + 3] < 128) continue;
      if (isEdgePixel(pixels, ix, iy, imgW, imgH)) continue;
      samples.push((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }
    return samples;
  }

  /** Collect edited-image colors for the snapshot method (same masking rules,
   *  no occlusion/palette filtering) — used to auto-create filament groups. */
  async _collectSnapshotSamples(painter, img, changedOnly, onProgress) {
    const d = this.data;
    const tmp = document.createElement('canvas');
    tmp.width = d.width;
    tmp.height = d.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0, d.width, d.height);
    const edited = ctx.getImageData(0, 0, d.width, d.height).data;
    deshadePixels(edited);
    const orig = d.original.data;
    const cen = painter.triCentroids, nor = painter.triNormals;
    const v = new THREE.Vector3(), dir = new THREE.Vector3();
    const samples = [];
    for (let t = 0; t < painter.triCount; t++) {
      if ((t & 0x7fff) === 0 && t > 0) {
        onProgress?.(0, 'reading image colors');
        await new Promise((r) => setTimeout(r, 0));
      }
      v.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]);
      if (d.ortho) dir.copy(d.forward);
      else dir.copy(v).sub(d.camPos).normalize();
      if (nor[t * 3] * dir.x + nor[t * 3 + 1] * dir.y + nor[t * 3 + 2] * dir.z > -0.15) continue;
      const p = v.applyMatrix4(d.viewProj);
      if (p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) continue;
      const px = Math.min(d.width - 1, Math.max(0, Math.round((p.x + 1) / 2 * d.width)));
      const py = Math.min(d.height - 1, Math.max(0, Math.round((1 - p.y) / 2 * d.height)));
      const i = (py * d.width + px) * 4;
      if (changedOnly) {
        const dr = edited[i] - orig[i], dg = edited[i + 1] - orig[i + 1], db = edited[i + 2] - orig[i + 2];
        if (dr * dr + dg * dg + db * db < 20 * 20) continue;
      }
      if (isEdgePixel(edited, px, py, d.width, d.height)) continue;
      samples.push((edited[i] << 16) | (edited[i + 1] << 8) | edited[i + 2]);
    }
    return samples;
  }

  /**
   * Sample the decal at an arbitrary surface point: returns the palette group
   * index, or -1 where the decal has no effect. Used by subdivision.
   */
  _makeDecalClassifier(painter, viewer, img, ov, tolerance) {
    const camera = viewer.camera;
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    const imgW = img.width, imgH = img.height;
    const tmp = document.createElement('canvas');
    tmp.width = imgW;
    tmp.height = imgH;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, imgW, imgH).data;
    deshadePixels(pixels);
    const palette = painter.groups.map((g) => {
      const n = parseInt(g.color.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const camPos = camera.position;
    const isOrtho = !camera.isPerspectiveCamera;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const origin = new THREE.Vector3();
    const cos = Math.cos(ov.rotDeg * Math.PI / 180);
    const sin = Math.sin(ov.rotDeg * Math.PI / 180);
    const tolSq = tolerance * tolerance * 3;
    const v = new THREE.Vector3();
    const pv = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const mesh = painter.mesh;

    // all cheap tests first; the occlusion raycast runs only for points that
    // would otherwise actually paint — a huge win on large meshes
    const classify = (x, y, z, nx, ny, nz) => {
      v.set(x, y, z);
      let dist;
      if (isOrtho) {
        dir.copy(fwd); // parallel rays
        dist = ORTHO_RAY;
      } else {
        dir.copy(v).sub(camPos);
        dist = dir.length();
        dir.divideScalar(dist);
      }
      if (nx * dir.x + ny * dir.y + nz * dir.z > -0.15) return -1;
      const p = pv.copy(v).project(camera);
      if (p.z > 1) return -1;
      const sx = (p.x + 1) / 2 * rect.width;
      const sy = (1 - p.y) / 2 * rect.height;
      const dx = sx - ov.cx, dy = sy - ov.cy;
      const lx = dx * cos + dy * sin + ov.w / 2;
      const ly = -dx * sin + dy * cos + ov.h / 2;
      if (lx < 0 || ly < 0 || lx >= ov.w || ly >= ov.h) return -1;
      const ix = Math.min(imgW - 1, Math.max(0, Math.round(lx / ov.w * imgW)));
      const iy = Math.min(imgH - 1, Math.max(0, Math.round(ly / ov.h * imgH)));
      const i = (iy * imgW + ix) * 4;
      if (pixels[i + 3] < 128) return -1;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      let best = -1, bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const c = palette[k];
        let e = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        // same hue at a different brightness beats a numerically-closer
        // wrong hue (shaded red must match red, not black)
        if (e > 900 && deshadeEnabled && sameChroma(r, g, b, c[0], c[1], c[2])) e *= 0.2;
        if (e < bestD) { bestD = e; best = k; }
      }
      if (bestD > tolSq) return -1;
      if (isOrtho) origin.copy(v).addScaledVector(fwd, -ORTHO_RAY);
      else origin.copy(camPos);
      raycaster.set(origin, dir);
      const hits = raycaster.intersectObject(mesh, false);
      if (!hits.length || hits[0].distance < dist - Math.max(0.05, isOrtho ? 0.1 : dist * 0.002)) return -1;
      return best;
    };

    // cheap scope test (no raycast, no sampling): could this point possibly
    // be affected? Used to skip whole triangles during subdivision.
    const rMax = Math.hypot(ov.w, ov.h) / 2;
    const inScope = (x, y, z) => {
      v.set(x, y, z);
      const p = v.project(camera);
      if (p.z > 1) return false;
      const sx = (p.x + 1) / 2 * rect.width;
      const sy = (1 - p.y) / 2 * rect.height;
      return Math.abs(sx - ov.cx) <= rMax && Math.abs(sy - ov.cy) <= rMax;
    };

    return { classify, inScope };
  }

  /**
   * Project a decal overlay onto the mesh through the CURRENT camera.
   * The overlay is a screen-space rectangle (viewport CSS px, rotated around
   * its center); transparent pixels (alpha < 128) are skipped. Colors snap to
   * the filament palette within tolerance. Caller manages the stroke.
   *
   * @param ov { cx, cy, w, h, rotDeg } overlay rect, viewport-relative CSS px
   */
  async applyDecal(painter, viewer, img, ov, { tolerance = 60, subdivide = 0, autoPalette = false, onProgress } = {}) {
    if (!painter.mesh) return null;
    const camera = viewer.camera;
    camera.updateMatrixWorld();
    const rect = viewer.renderer.domElement.getBoundingClientRect();

    // Optional pre-pass: subdivide triangles that straddle decal color
    // boundaries so the painted edge is crisper than the source tessellation.
    if (subdivide > 0) {
      // in auto-palette mode the groups don't exist yet — classify wide open
      // so decal-vs-outside boundaries still split
      const subdivTol = autoPalette ? 999 : tolerance;
      const { classify, inScope } = this._makeDecalClassifier(painter, viewer, img, ov, subdivTol);
      const bb = painter.mesh.geometry.boundingBox;
      const diag = bb.min.distanceTo(bb.max);
      // higher Detail levels lower the refinement floor so small text keeps
      // gaining fidelity instead of hitting the coarse floor
      const minEdgeVal = Math.max(0.1, diag * (subdivide >= 5 ? 0.0015 : 0.003));

      // phase-1 target: bring in-scope triangles down to decal scale, so
      // lathe-style slivers (huge triangles the decal only crosses in the
      // middle) can't slip past corner/centroid sampling
      const center = bb.getCenter(new THREE.Vector3());
      const dist = camera.position.distanceTo(center);
      const worldPerPx = camera.isPerspectiveCamera
        ? (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / rect.height
        : (camera.top - camera.bottom) / camera.zoom / rect.height;
      // phase-1 target scales with Detail: finer levels pre-cut triangles
      // small enough that thin features (letter strokes) can't slip between
      // the classification sample points
      const maxEdge = Math.max(minEdgeVal * 2, (Math.min(ov.w, ov.h) * worldPerPx) / (2 * subdivide));

      // triangle-level scope: projected screen bbox vs overlay bbox — catches
      // triangles whose corners all fall outside the overlay
      const rMax = Math.hypot(ov.w, ov.h) / 2;
      const v3 = new THREE.Vector3();
      const triInScope = (pos, o) => {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let anyFront = false;
        for (let k = 0; k < 3; k++) {
          v3.set(pos[o + k * 3], pos[o + k * 3 + 1], pos[o + k * 3 + 2]).project(camera);
          if (v3.z <= 1) anyFront = true;
          const sx = (v3.x + 1) / 2 * rect.width;
          const sy = (1 - v3.y) / 2 * rect.height;
          if (sx < minX) minX = sx;
          if (sx > maxX) maxX = sx;
          if (sy < minY) minY = sy;
          if (sy > maxY) maxY = sy;
        }
        if (!anyFront) return false;
        return maxX >= ov.cx - rMax && minX <= ov.cx + rMax &&
               maxY >= ov.cy - rMax && minY <= ov.cy + rMax;
      };

      const refined = await refineMesh(
        painter.mesh.geometry.attributes.position.array,
        painter.triGroup,
        painter.blocked,
        classify,
        {
          maxRounds: subdivide,
          minEdge: minEdgeVal,
          inScope,
          triInScope,
          maxEdge,
          onProgress: onProgress ? (f) => onProgress(f * 0.6, 'subdividing') : undefined,
        }
      );
      painter.adoptRefined(refined.positions, refined.triGroup, refined.blocked);
    }

    // auto-create filament groups from the image's dominant colors — AFTER
    // subdivision, so sliver-topology meshes have sampleable triangles
    let created = 0;
    if (autoPalette) {
      const samples = await this._collectDecalSamples(painter, viewer, img, ov, onProgress);
      created = createGroupsFromSamples(painter, samples);
      tolerance = 999; // palette now spans the image — accept every visible pixel
    }

    const imgW = img.width, imgH = img.height;
    const tmp = document.createElement('canvas');
    tmp.width = imgW;
    tmp.height = imgH;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, imgW, imgH).data;
    deshadePixels(pixels);

    const palette = painter.groups.map((g) => {
      const n = parseInt(g.color.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const camPos = camera.position;
    const isOrtho = !camera.isPerspectiveCamera;
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const origin = new THREE.Vector3();
    const cen = painter.triCentroids;
    const nor = painter.triNormals;
    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const cos = Math.cos(ov.rotDeg * Math.PI / 180);
    const sin = Math.sin(ov.rotDeg * Math.PI / 180);
    const tolSq = tolerance * tolerance * 3;
    const counts = { applied: 0, outside: 0, transparent: 0, noMatch: 0, hidden: 0 };

    for (let t = 0; t < painter.triCount; t++) {
      if ((t & 0x7fff) === 0 && t > 0) {
        onProgress?.(0.6 + 0.4 * (t / painter.triCount), 'painting');
        await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
      }
      v.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]);
      let dist;
      if (isOrtho) {
        dir.copy(fwd); // parallel rays
        dist = ORTHO_RAY;
      } else {
        dir.copy(v).sub(camPos);
        dist = dir.length();
        dir.divideScalar(dist);
      }

      const ndotv = nor[t * 3] * dir.x + nor[t * 3 + 1] * dir.y + nor[t * 3 + 2] * dir.z;
      if (ndotv > -0.15) {
        counts.hidden++;
        continue;
      }

      const p = v.project(camera);
      if (p.z > 1) continue;
      const sx = (p.x + 1) / 2 * rect.width;
      const sy = (1 - p.y) / 2 * rect.height;

      // screen → overlay-local coords, undoing the rotation about its center
      const dx = sx - ov.cx, dy = sy - ov.cy;
      const lx = dx * cos + dy * sin + ov.w / 2;
      const ly = -dx * sin + dy * cos + ov.h / 2;
      if (lx < 0 || ly < 0 || lx >= ov.w || ly >= ov.h) {
        counts.outside++;
        continue;
      }

      const ix = Math.min(imgW - 1, Math.max(0, Math.round(lx / ov.w * imgW)));
      const iy = Math.min(imgH - 1, Math.max(0, Math.round(ly / ov.h * imgH)));
      const i = (iy * imgW + ix) * 4;
      if (pixels[i + 3] < 128) {
        counts.transparent++;
        continue;
      }
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];

      let best = -1, bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const c = palette[k];
        let e = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        // same hue at a different brightness beats a numerically-closer
        // wrong hue (shaded red must match red, not black)
        if (e > 900 && deshadeEnabled && sameChroma(r, g, b, c[0], c[1], c[2])) e *= 0.2;
        if (e < bestD) {
          bestD = e;
          best = k;
        }
      }
      if (bestD > tolSq) {
        counts.noMatch++;
        continue;
      }

      // occlusion last — only pixels that would actually paint pay for a raycast
      if (isOrtho) origin.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]).addScaledVector(fwd, -ORTHO_RAY);
      else origin.copy(camPos);
      raycaster.set(origin, dir);
      const hits = raycaster.intersectObject(painter.mesh, false);
      if (!hits.length || hits[0].distance < dist - Math.max(0.05, isOrtho ? 0.1 : dist * 0.002)) {
        counts.hidden++;
        continue;
      }
      painter._assign(t, best);
      counts.applied++;
    }

    painter.mesh.geometry.attributes.color.needsUpdate = true;
    counts.created = created;
    return counts;
  }

  /**
   * Project an edited image back onto the mesh. The caller manages the stroke.
   * @param img ImageBitmap/HTMLImageElement of the edited snapshot
   * @param tolerance max per-channel-ish RGB distance for palette snapping
   * @param changedOnly only apply where the image differs from the snapshot
   * @returns counts for the status line
   */
  async apply(painter, img, { tolerance = 60, changedOnly = true, autoPalette = false, onProgress } = {}) {
    const d = this.data;
    if (!d || !painter.mesh) return null;

    let created = 0;
    if (autoPalette) {
      const samples = await this._collectSnapshotSamples(painter, img, changedOnly, onProgress);
      created = createGroupsFromSamples(painter, samples);
      tolerance = 999; // palette now spans the image — accept every visible pixel
    }

    // rescale the edited image onto the snapshot's pixel grid, so any export
    // resolution works as long as the framing wasn't cropped
    const tmp = document.createElement('canvas');
    tmp.width = d.width;
    tmp.height = d.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(img, 0, 0, d.width, d.height);
    const edited = ctx.getImageData(0, 0, d.width, d.height).data;
    deshadePixels(edited);
    const orig = d.original.data;

    const palette = painter.groups.map((g) => {
      const n = parseInt(g.color.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    });

    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true;
    const cen = painter.triCentroids;
    const nor = painter.triNormals;
    const v = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const tolSq = tolerance * tolerance * 3;

    const counts = { applied: 0, unchanged: 0, noMatch: 0, hidden: 0, offscreen: 0 };

    for (let t = 0; t < painter.triCount; t++) {
      if ((t & 0x7fff) === 0 && t > 0) {
        onProgress?.(t / painter.triCount, 'painting');
        await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
      }
      v.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]);
      let dist;
      if (d.ortho) {
        dir.copy(d.forward); // parallel rays
        dist = ORTHO_RAY;
      } else {
        dir.copy(v).sub(d.camPos);
        dist = dir.length();
        dir.divideScalar(dist);
      }

      // skip backfacing and grazing triangles (project from another angle instead)
      const ndotv = nor[t * 3] * dir.x + nor[t * 3 + 1] * dir.y + nor[t * 3 + 2] * dir.z;
      if (ndotv > -0.15) {
        counts.hidden++;
        continue;
      }

      const p = v.applyMatrix4(d.viewProj); // perspective divide included
      if (p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) {
        counts.offscreen++;
        continue;
      }

      const px = Math.min(d.width - 1, Math.max(0, Math.round((p.x + 1) / 2 * d.width)));
      const py = Math.min(d.height - 1, Math.max(0, Math.round((1 - p.y) / 2 * d.height)));
      const i = (py * d.width + px) * 4;
      const r = edited[i], g = edited[i + 1], b = edited[i + 2];

      if (changedOnly) {
        const dr = r - orig[i], dg = g - orig[i + 1], db = b - orig[i + 2];
        if (dr * dr + dg * dg + db * db < 20 * 20) {
          counts.unchanged++;
          continue;
        }
      }

      let best = -1, bestD = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const c = palette[k];
        let e = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        // same hue at a different brightness beats a numerically-closer
        // wrong hue (shaded red must match red, not black)
        if (e > 900 && deshadeEnabled && sameChroma(r, g, b, c[0], c[1], c[2])) e *= 0.2;
        if (e < bestD) {
          bestD = e;
          best = k;
        }
      }
      if (bestD > tolSq) {
        counts.noMatch++;
        continue;
      }

      // occlusion last — only pixels that would actually paint pay for a raycast
      if (d.ortho) origin.set(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2]).addScaledVector(d.forward, -ORTHO_RAY);
      else origin.copy(d.camPos);
      raycaster.set(origin, dir);
      const hits = raycaster.intersectObject(painter.mesh, false);
      if (!hits.length || hits[0].distance < dist - Math.max(0.05, d.ortho ? 0.1 : dist * 0.002)) {
        counts.hidden++;
        continue;
      }
      painter._assign(t, best);
      counts.applied++;
    }

    painter.mesh.geometry.attributes.color.needsUpdate = true;
    counts.created = created;
    return counts;
  }
}
