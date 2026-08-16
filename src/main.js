import './style.css';
import { Viewer } from './viewer.js';
import { Painter } from './painter.js';
import { exportMultiPart3MF, exportPainted3MF } from './export3mf.js';
import { ProjectionSession, setDeshade } from './projection.js';
import { removeBackground } from './imagebg.js';
import { parse3MF } from './import3mf.js';
import { rasterizeGlyphs, buildPlacements, buildTextClassifier } from './curvedtext.js';

const viewer = new Viewer(document.getElementById('viewport'));
const painter = new Painter();
const projection = new ProjectionSession();
window.__mp = { viewer, painter, projection };

const status = document.getElementById('statusbar');
const groupsEl = document.getElementById('groups');
const fileInput = document.getElementById('file-input');

let tool = 'brush';
let brushRadius = 5;
let fillAngle = 30;
let lineWidth = 3;
let linePoints = [];   // [{ point: Vector3, tri: faceIndex }] the user dropped
let lineRedo = [];     // points removed by undo, awaiting redo
let lineDrape = [];    // cached surface-hugging centerline for preview/commit
let lineChain = null;  // cached geodesic triangle chain (Surface mode)
let lineAllGeodesic = false; // false if any segment fell back to a straight chord
let segCache = [];     // per-segment { drape, chain }, reused across point edits
let modelName = 'model';

// active pointer interaction: null | 'brush' | 'blocker' | 'scrub'
let dragMode = null;
let scrubStartX = 0;
let scrubLimit = 0;
let strokePath = [];      // brush hit points, for crisp-edge subdivision
let strokeErase = false;
let refining = false;     // blocks input while a stroke is being subdivided

function setStatus(msg) {
  status.textContent = msg;
}

// ---- file loading ----

document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  await loadFile(file);
  fileInput.value = '';
});

const viewport = document.getElementById('viewport');
viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && /\.(stl|3mf)$/i.test(file.name)) await loadFile(file);
});

async function loadFile(file) {
  setStatus(`Loading ${file.name}…`);
  const buffer = await file.arrayBuffer();
  try {
    let mesh;
    let imported = null;
    if (/\.3mf$/i.test(file.name)) {
      imported = parse3MF(buffer);
      mesh = viewer.loadPositions(imported.positions);
    } else {
      mesh = viewer.loadSTL(buffer);
    }
    modelName = file.name.replace(/\.(stl|3mf)$/i, '');
    painter.setMesh(mesh);
    clearLine();
    projection.clear();
    document.getElementById('btn-proj-import').disabled = true;
    document.getElementById('btn-proj-return').disabled = true;

    if (imported) {
      let maxG = 0;
      for (const g of imported.triGroup) if (g > maxG) maxG = g;
      while (painter.groups.length <= Math.min(maxG, 15)) painter.addGroup();
      if (imported.filamentColors) {
        imported.filamentColors.forEach((c, i) => {
          if (painter.groups[i]) painter.groups[i].color = c;
        });
      }
      painter.triGroup.set(imported.triGroup);
      painter.repaintAll();
      renderGroups();
      const painted = imported.triGroup.reduce((a, g) => a + (g > 0 ? 1 : 0), 0);
      setStatus(`${file.name} — ${painter.triCount.toLocaleString()} triangles, ${painted.toLocaleString()} painted across ${maxG + 1} filament slot(s).`);
    } else {
      setStatus(`${file.name} — ${painter.triCount.toLocaleString()} triangles. Middle-drag to rotate, right-drag to pan, left-drag to paint.`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message}`);
  }
}

// ---- tools ----

const toolButtons = document.querySelectorAll('.tool');
function setTool(name) {
  tool = name;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  const isBrushy = name === 'brush' || name === 'blocker';
  document.getElementById('brush-size-wrap').style.display = isBrushy ? '' : 'none';
  document.getElementById('through-wrap').style.display = isBrushy ? '' : 'none';
  document.getElementById('stroke-subdiv-wrap').style.display =
    isBrushy || name === 'line' ? '' : 'none';
  document.getElementById('fill-angle-wrap').style.display = name === 'fill' ? '' : 'none';
  document.getElementById('line-width-wrap').style.display = name === 'line' ? '' : 'none';
  document.getElementById('line-surface-wrap').style.display = name === 'line' ? '' : 'none';
  document.getElementById('line-actions').style.display = name === 'line' ? '' : 'none';
  if (name === 'brush') setStatus('Brush: drag to paint, Alt-drag to erase back to base.');
  if (name === 'blocker') setStatus('Blocker: drag to paint fill barriers, Alt-drag to erase them.');
  if (name === 'fill') setStatus('Smart Fill: click to fill, keep the button held and drag right/left to grow/shrink the fill.');
  if (name === 'line') setStatus('Line: click to drop points, Backspace removes the last one. Commit with "Paint line" or "Block line".');
}
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
setTool('brush');

document.getElementById('brush-size').addEventListener('input', (e) => {
  brushRadius = parseFloat(e.target.value);
  document.getElementById('brush-size-val').textContent = brushRadius;
});
document.getElementById('fill-angle').addEventListener('input', (e) => {
  fillAngle = parseFloat(e.target.value);
  document.getElementById('fill-angle-val').textContent = fillAngle + '°';
});
document.getElementById('line-width').addEventListener('input', (e) => {
  lineWidth = parseFloat(e.target.value);
  document.getElementById('line-width-val').textContent = lineWidth;
  refreshLinePreview();
});

// ---- line tool ----

function surfaceMode() {
  return document.getElementById('line-surface').checked;
}

/** Geodesic (or straight-fallback) path for one segment a→b. */
function computeSegment(a, b) {
  const sp = painter.surfacePath(a.tri, a.point, b.tri, b.point);
  // null = disconnected shells; fall back to a straight chord for this segment
  if (!sp) return { drape: [a.point.clone(), b.point.clone()], chain: null };
  return { drape: sp.polyPoints, chain: sp.triChain };
}

/** Concatenated surface-hugging drape through a list of {point, tri} hits. */
function geodesicDrape(pts) {
  if (pts.length < 2) return pts.map((p) => p.point.clone());
  const drape = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = computeSegment(pts[i], pts[i + 1]);
    const start = drape.length ? 1 : 0;
    for (let k = start; k < seg.drape.length; k++) drape.push(seg.drape[k]);
  }
  return drape;
}

/**
 * Recompute the stripe centerline from the dropped points. In Surface mode
 * each segment between consecutive points is a geodesic drape over the mesh
 * (so it can't tunnel under a curve); in Straight mode it's the raw chord.
 * Per-segment results are cached in segCache — points are only ever added or
 * removed at the tail, so only the new tail segment runs a fresh Dijkstra;
 * the rest are reused, which keeps big meshes responsive as points pile up.
 * Sets lineDrape, lineChain, and lineAllGeodesic (false if any segment fell
 * back to a straight chord — commit then paints the drape directly).
 */
function rebuildLinePath() {
  const surface = surfaceMode();
  if (!surface || linePoints.length < 2 || !painter.mesh) {
    lineDrape = linePoints.map((p) => p.point.clone());
    lineChain = null;
    lineAllGeodesic = false;
    segCache = [];
    return;
  }
  const need = linePoints.length - 1;
  if (segCache.length > need) segCache.length = need; // a point was removed
  for (let i = 0; i < need; i++) {
    if (!segCache[i]) segCache[i] = computeSegment(linePoints[i], linePoints[i + 1]);
  }
  const drape = [];
  const chain = [];
  let allGeodesic = true;
  for (const seg of segCache) {
    const start = drape.length ? 1 : 0; // skip the shared junction point
    for (let k = start; k < seg.drape.length; k++) drape.push(seg.drape[k]);
    if (seg.chain) {
      for (const t of seg.chain) {
        if (!chain.length || chain[chain.length - 1] !== t) chain.push(t);
      }
    } else {
      allGeodesic = false;
    }
  }
  lineDrape = drape;
  lineChain = chain.length ? chain : null;
  lineAllGeodesic = allGeodesic;
}

/** Remove the last dropped point (Backspace / Ctrl+Z), keeping it for redo. */
function removeLastLinePoint() {
  if (!linePoints.length) return false;
  lineRedo.push(linePoints.pop());
  rebuildLinePath();
  refreshLinePreview();
  return true;
}

/** Restore the most recently removed point (Ctrl+Y / Ctrl+Shift+Z). */
function restoreLinePoint() {
  if (!lineRedo.length) return false;
  linePoints.push(lineRedo.pop());
  rebuildLinePath();
  refreshLinePreview();
  return true;
}

function refreshLinePreview() {
  const colorHex = parseInt(painter.groups[painter.activeGroup].color.slice(1), 16);
  viewer.setPolylinePreview(
    linePoints.map((p) => p.point), lineDrape, lineWidth, colorHex);
}

function clearLine() {
  linePoints = [];
  lineRedo = [];
  lineDrape = [];
  lineChain = null;
  lineAllGeodesic = false;
  segCache = [];
  viewer.clearPolylinePreview();
}

async function commitLine(asBlocker) {
  if (!painter.mesh || !linePoints.length || refining) return;
  rebuildLinePath();
  if (document.getElementById('stroke-subdiv').checked) {
    refining = true;
    try {
      // subdivision rebuilds the mesh, so the geodesic chain is invalidated;
      // the draped polyline is on the surface, so a straight-segment repaint of
      // it no longer tunnels
      await painter.refineStroke(lineDrape, lineWidth / 2, {
        rounds: 3,
        onProgress: (f) => setStatus(`Refining line edges — ${Math.round(f * 100)}%…`),
      });
      const n = painter.paintPolyline(lineDrape, lineWidth, asBlocker);
      setStatus(`${asBlocker ? 'Blocked' : 'Painted'} ${n} triangles along the line with crisp edges — mesh now ${painter.triCount.toLocaleString()} triangles (undo history cleared).`);
    } catch (err) {
      console.error(err);
      setStatus(`Line refinement failed: ${err.message}`);
    } finally {
      refining = false;
    }
  } else {
    painter.beginStroke();
    // geodesic stripe when every segment draped on the surface; otherwise the
    // on-surface drape (covers straight-fallback segments too)
    const n = (surfaceMode() && lineChain && lineAllGeodesic)
      ? painter.paintSurfaceStripe(lineChain, lineWidth, asBlocker)
      : painter.paintPolyline(lineDrape, lineWidth, asBlocker);
    painter.endStroke();
    setStatus(asBlocker
      ? `Blocked ${n} triangles along the line.`
      : `Painted ${n} triangles along the line with "${painter.groups[painter.activeGroup].name}".`);
  }
  clearLine();
}

document.getElementById('line-surface').addEventListener('change', () => {
  rebuildLinePath();
  refreshLinePreview();
  setStatus(surfaceMode()
    ? 'Line: stripe clings to the surface between points.'
    : 'Line: straight chords between points (may cut under curves).');
});

document.getElementById('btn-line-paint').addEventListener('click', () => commitLine(false));
document.getElementById('btn-line-block').addEventListener('click', () => commitLine(true));
document.getElementById('btn-line-clear').addEventListener('click', () => {
  clearLine();
  setStatus('Line cleared.');
});

// ---- slider ergonomics: wheel = one precise step, double-click = reset ----

document.addEventListener('wheel', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
  e.preventDefault();
  const step = parseFloat(el.step) || 1;
  const dir = e.deltaY < 0 ? 1 : -1;
  const mult = e.shiftKey ? 5 : 1;
  el.value = Math.min(parseFloat(el.max), Math.max(parseFloat(el.min),
    parseFloat(el.value) + dir * step * mult));
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, { passive: false });

document.addEventListener('dblclick', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.type !== 'range') return;
  const def = el.dataset.default;
  if (def === undefined) return;
  el.value = def;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---- view presets & projection mode ----

document.querySelectorAll('#view-cluster [data-view]').forEach((b) => {
  b.addEventListener('click', () => {
    viewer.setView(b.dataset.view);
    setStatus(`${b.textContent} view.`);
  });
});
document.getElementById('btn-ortho').addEventListener('click', () => {
  const toOrtho = viewer.camera.isPerspectiveCamera;
  viewer.setOrtho(toOrtho);
  document.getElementById('btn-ortho').classList.toggle('active', toOrtho);
  setStatus(toOrtho ? 'Orthographic projection.' : 'Perspective projection.');
});

// ---- decal overlay ----

const decalOv = document.getElementById('decal-overlay');
const decal = { img: null, x: 40, y: 40, w: 320, h: 240, baseW: 320, rot: 0 };
window.__mp.decal = decal;
let decalDrag = null; // { mode: 'move'|'resize', dx, dy }

function positionDecal() {
  decalOv.style.left = decal.x + 'px';
  decalOv.style.top = decal.y + 'px';
  decalOv.style.width = decal.w + 'px';
  decalOv.style.height = decal.h + 'px';
  decalOv.style.transformOrigin = 'center center';
  decalOv.style.transform = `rotate(${decal.rot}deg)`;
}

function resetDecal() {
  const r = viewport.getBoundingClientRect();
  const ar = decal.img ? decal.img.height / decal.img.width : 0.75;
  decal.w = Math.min(r.width * 0.5, 400);
  decal.h = decal.w * ar;
  decal.x = (r.width - decal.w) / 2;
  decal.y = (r.height - decal.h) / 2;
  decal.baseW = decal.w;
  decal.rot = 0;
  document.getElementById('decal-scale').value = 100;
  document.getElementById('decal-scale-val').textContent = '100%';
  document.getElementById('decal-rot').value = 0;
  document.getElementById('decal-rot-val').textContent = '0°';
  positionDecal();
}

decalOv.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  decalDrag = {
    mode: e.target.id === 'decal-handle' ? 'resize' : 'move',
    dx: e.clientX - r.left - decal.x,
    dy: e.clientY - r.top - decal.y,
  };
});
window.addEventListener('pointermove', (e) => {
  if (!decalDrag) return;
  const r = viewport.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  if (decalDrag.mode === 'move') {
    decal.x = mx - decalDrag.dx;
    decal.y = my - decalDrag.dy;
  } else {
    const ar = decal.img ? decal.img.height / decal.img.width : decal.h / decal.w;
    decal.w = Math.max(40, mx - decal.x);
    decal.h = decal.w * ar;
    syncDecalScaleSlider();
  }
  positionDecal();
});
window.addEventListener('pointerup', () => { decalDrag = null; });
decalOv.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const ar = decal.img ? decal.img.height / decal.img.width : decal.h / decal.w;
  const cx = decal.x + decal.w / 2, cy = decal.y + decal.h / 2;
  decal.w = Math.max(40, decal.w * (e.deltaY > 0 ? 0.92 : 1.09));
  decal.h = decal.w * ar;
  decal.x = cx - decal.w / 2;
  decal.y = cy - decal.h / 2;
  syncDecalScaleSlider();
  positionDecal();
}, { passive: false });

function syncDecalScaleSlider() {
  const pct = Math.round(decal.w / decal.baseW * 100);
  document.getElementById('decal-scale').value = Math.min(400, Math.max(10, pct));
  document.getElementById('decal-scale-val').textContent = pct + '%';
}

document.getElementById('decal-scale').addEventListener('input', (e) => {
  const pct = parseFloat(e.target.value);
  const ar = decal.img ? decal.img.height / decal.img.width : decal.h / decal.w;
  const cx = decal.x + decal.w / 2, cy = decal.y + decal.h / 2;
  decal.w = Math.max(20, decal.baseW * pct / 100);
  decal.h = decal.w * ar;
  decal.x = cx - decal.w / 2;
  decal.y = cy - decal.h / 2;
  document.getElementById('decal-scale-val').textContent = pct + '%';
  positionDecal();
});
document.getElementById('decal-rot').addEventListener('input', (e) => {
  decal.rot = parseFloat(e.target.value);
  document.getElementById('decal-rot-val').textContent = decal.rot + '°';
  positionDecal();
});
document.getElementById('decal-opacity').addEventListener('input', (e) => {
  decalOv.style.opacity = e.target.value / 100;
});

document.getElementById('btn-decal-load').addEventListener('click', () => {
  document.getElementById('decal-file').click();
});
/** Show a loaded image/text bitmap in the decal overlay, wiring the existing
 *  background-removal + apply controls. */
async function presentDecal(originalImg, originalUrl, statusMsg) {
  decal.originalImg = originalImg;
  decal.originalUrl = originalUrl;
  // fresh image, fresh choices — a stale toggle from a previous image can
  // silently swallow whole color regions
  document.getElementById('decal-bg-remove').checked = false;
  await reprocessDecal();
  document.getElementById('decal-controls').style.display = '';
  decalOv.style.display = 'block';
  decalOv.style.opacity = document.getElementById('decal-opacity').value / 100;
  resetDecal();
  setStatus(statusMsg);
}

document.getElementById('decal-file').addEventListener('change', async () => {
  const file = document.getElementById('decal-file').files[0];
  document.getElementById('decal-file').value = '';
  if (!file) return;
  const bmp = await createImageBitmap(file);
  await presentDecal(bmp, URL.createObjectURL(file),
    'Decal loaded — drag to position, corner/scroll to resize, then Apply. Orbit the model behind it as needed.');
});

// ---- text decal ----

const GENERIC_FONTS = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
const FALLBACK_FONTS = [
  'Arial', 'Helvetica', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Georgia',
  'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS',
  ...GENERIC_FONTS,
];

function fillFontOptions(families) {
  const sel = document.getElementById('text-font');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const fam of families) {
    const o = document.createElement('option');
    o.value = fam;
    o.textContent = fam;
    sel.append(o);
  }
  if (families.includes(prev)) sel.value = prev;
}
fillFontOptions(FALLBACK_FONTS);

// Read the user's actually-installed fonts via the Local Font Access API.
// It needs a user gesture + permission, so it's behind the ⟳ button and falls
// back to the common-font list when unavailable or denied.
document.getElementById('btn-text-fonts').addEventListener('click', async () => {
  if (!window.queryLocalFonts) {
    setStatus('This browser can’t enumerate system fonts (Chrome/Edge only) — using the common-font list.');
    return;
  }
  try {
    const fonts = await window.queryLocalFonts();
    const fams = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    if (!fams.length) return setStatus('No system fonts returned — keeping the common-font list.');
    fillFontOptions([...fams, ...GENERIC_FONTS]);
    setStatus(`Loaded ${fams.length} installed font(s).`);
  } catch {
    setStatus('Font access was denied — using the common-font list.');
  }
});

/** CSS font-family token: generics bare, everything else quoted. */
function cssFontFamily(family) {
  return GENERIC_FONTS.includes(family) ? family : JSON.stringify(family);
}

/** Rasterize text to a transparent canvas, filled in the active filament
 *  color, ready to feed the decal projection pipeline. */
function buildTextCanvas(text, family, bold, italic, color) {
  const fontSize = 160; // high raster res; on-model size is set by the overlay
  const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${fontSize}px ${cssFontFamily(family)}`;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  const lines = text.split('\n');
  let maxW = 1;
  for (const ln of lines) maxW = Math.max(maxW, meas.measureText(ln).width);
  const lineH = fontSize * 1.28;
  const pad = fontSize * 0.28;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(maxW + pad * 2);
  canvas.height = Math.ceil(lineH * lines.length + pad * 2);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], canvas.width / 2, pad + i * lineH);
  }
  return canvas;
}

document.getElementById('btn-text-create').addEventListener('click', async () => {
  const text = document.getElementById('text-input').value.trim();
  if (!text) return setStatus('Type some text first.');
  const family = document.getElementById('text-font').value || 'sans-serif';
  // make sure the chosen font is actually loaded before we rasterize
  try { await document.fonts.load(`160px ${cssFontFamily(family)}`); } catch { /* generic/system font */ }
  if (document.getElementById('text-wrap').checked) return startTextPlacement(text, family);
  const color = painter.groups[painter.activeGroup].color;
  const canvas = buildTextCanvas(
    text, family,
    document.getElementById('text-bold').checked,
    document.getElementById('text-italic').checked,
    color
  );
  const bmp = await createImageBitmap(canvas);
  await presentDecal(bmp, canvas.toDataURL(),
    `Text decal created in "${painter.groups[painter.activeGroup].name}" — position it over the model, then Apply decal.`);
});

// ---- curved (per-glyph "use surface") text ----

let textPlacing = false;
let textPath = [];      // [{ point, tri }] baseline hits on the model
let textLayout = null;  // pre-rasterized glyphs for the placement in progress

document.getElementById('text-wrap').addEventListener('change', () => {
  const on = document.getElementById('text-wrap').checked;
  document.getElementById('text-height-wrap').style.display = on ? '' : 'none';
  document.getElementById('text-detail-wrap').style.display = on ? '' : 'none';
  document.getElementById('btn-text-create').textContent = on ? 'Place curved text…' : 'Create text decal';
  document.getElementById('text-hint').textContent = on
    ? 'Click points on the model to lay the text baseline (2+), then Apply. Each glyph projects in its own surface frame, so text wraps around cylinders. Detail (below) controls edge crispness.'
    : 'Renders your text as a decal in the active filament color. Position it over the model, then Apply decal below. Works on flat and gently curved faces.';
});

function startTextPlacement(text, family) {
  if (!painter.mesh) return setStatus('Open a model first.');
  textLayout = rasterizeGlyphs(text, {
    family,
    bold: document.getElementById('text-bold').checked,
    italic: document.getElementById('text-italic').checked,
  });
  textPlacing = true;
  textPath = [];
  document.getElementById('text-place-actions').style.display = '';
  document.getElementById('btn-text-create').style.display = 'none';
  viewer.clearPolylinePreview();
  setStatus('Curved text: click points on the model to lay the baseline (2 or more), then "Apply curved text".');
}

function refreshTextBaseline() {
  if (!textPlacing) return;
  const heightMm = parseFloat(document.getElementById('text-height').value) || 10;
  const colorHex = parseInt(painter.groups[painter.activeGroup].color.slice(1), 16);
  viewer.setPolylinePreview(
    textPath.map((p) => p.point), geodesicDrape(textPath), heightMm, colorHex);
}

function endTextPlacement() {
  textPlacing = false;
  textPath = [];
  textLayout = null;
  document.getElementById('text-place-actions').style.display = 'none';
  document.getElementById('btn-text-create').style.display = '';
  viewer.clearPolylinePreview();
}

document.getElementById('btn-text-cancel').addEventListener('click', () => {
  endTextPlacement();
  setStatus('Curved text cancelled.');
});

document.getElementById('btn-text-apply').addEventListener('click', async () => {
  if (!textPlacing || textPath.length < 2) {
    return setStatus('Click at least two points on the model for the text baseline.');
  }
  const heightMm = parseFloat(document.getElementById('text-height').value) || 10;
  const drape = geodesicDrape(textPath);
  const placements = buildPlacements(textLayout, drape, heightMm, painter.mesh, painter.triNormals);
  if (!placements.length) return setStatus('No printable glyphs to place.');
  const group = painter.activeGroup;
  const { classify, inScope, triInScope } = buildTextClassifier(placements, group, heightMm);
  const subdivide = parseInt(document.getElementById('text-subdiv').value, 10);
  const layout = textLayout, path = textPath.slice();
  document.getElementById('btn-text-apply').disabled = true;
  setStatus('Applying curved text…');
  try {
    const applied = await painter.applyRegionPaint(classify, {
      subdivide,
      inScope,
      triInScope,
      // start phase-1 near the stroke width (~height/8), not the glyph height,
      // so thin crossbars survive the boundary refinement
      maxEdge: Math.max(0.6, heightMm * 0.22),
      onProgress: (f, phase) => setStatus(`Applying curved text — ${phase || ''} ${Math.round(f * 100)}%…`),
    });
    if (applied === 0) {
      setStatus('Curved text landed nothing — try a larger Height, a Detail level of Fine+, or points closer to the surface.');
    } else {
      setStatus(`Curved text applied: ${applied} triangles painted in "${painter.groups[group].name}"` +
        (subdivide
          ? ` — mesh now ${painter.triCount.toLocaleString()} triangles (undo history cleared).`
          : ' (Ctrl+Z to undo).'));
    }
    endTextPlacement();
  } catch (err) {
    console.error(err);
    setStatus(`Curved text failed: ${err.message}`);
    textLayout = layout; textPath = path; // keep the placement so they can retry
  } finally {
    document.getElementById('btn-text-apply').disabled = false;
  }
});

// ---- decal background removal (non-destructive: always from the original) ----

let bgToken = 0;
async function reprocessDecal() {
  if (!decal.originalImg) return;
  const token = ++bgToken;
  const on = document.getElementById('decal-bg-remove').checked;
  document.getElementById('bg-tol-wrap').style.display = on ? '' : 'none';
  document.getElementById('bg-edge-wrap').style.display = on ? '' : 'none';
  if (!on) {
    decal.img = decal.originalImg;
    document.getElementById('decal-img').src = decal.originalUrl;
    return;
  }
  const { canvas, removedFraction } = removeBackground(decal.originalImg, {
    tolerance: parseFloat(document.getElementById('decal-bg-tol').value),
    edge: parseInt(document.getElementById('decal-bg-edge').value, 10),
  });
  const bmp = await createImageBitmap(canvas);
  if (token !== bgToken) return; // a newer reprocess superseded this one
  decal.img = bmp;
  document.getElementById('decal-img').src = canvas.toDataURL();
  if (removedFraction > 0.6) {
    setStatus(`Background removal cut ${Math.round(removedFraction * 100)}% of the image — if that ate your subject, lower BG tolerance or toggle it off.`);
  }
}

document.getElementById('decal-bg-remove').addEventListener('change', reprocessDecal);
document.getElementById('decal-bg-tol').addEventListener('input', (e) => {
  document.getElementById('decal-bg-tol-val').textContent = e.target.value;
  reprocessDecal();
});
document.getElementById('decal-bg-edge').addEventListener('input', (e) => {
  document.getElementById('decal-bg-edge-val').textContent = e.target.value;
  reprocessDecal();
});

document.getElementById('btn-decal-apply').addEventListener('click', async () => {
  if (!painter.mesh) return setStatus('Open an STL first.');
  if (!decal.img) return setStatus('Load a decal image first.');
  const btn = document.getElementById('btn-decal-apply');
  if (btn.disabled) return;
  const subdivide = parseInt(document.getElementById('decal-subdiv').value, 10);
  const ov = {
    cx: decal.x + decal.w / 2,
    cy: decal.y + decal.h / 2,
    w: decal.w,
    h: decal.h,
    rotDeg: decal.rot,
  };
  const opts = {
    tolerance: parseFloat(document.getElementById('proj-tolerance').value),
    subdivide,
    autoPalette: document.getElementById('proj-auto-colors').checked,
    onProgress: (f, phase) => setStatus(`Applying decal — ${phase} ${Math.round(f * 100)}%…`),
  };
  btn.disabled = true;
  setStatus('Applying decal…');
  try {
    // subdivision rebuilds the geometry, so it cannot be captured as an undo stroke
    if (!subdivide) painter.beginStroke();
    const c = await projection.applyDecal(painter, viewer, decal.img, ov, opts);
    if (!subdivide) painter.endStroke();
    if (c.created > 0) renderGroups();
    setStatus(
      `Decal applied: ${c.applied} triangles painted · ${c.transparent} transparent · ` +
      `${c.noMatch} no color match · ${c.hidden} hidden.` +
      (c.created > 0 ? ` Created ${c.created} color group(s) from the image.` : '') +
      (c.applied === 0 && !subdivide
        ? ' Nothing landed — on coarse/lathe meshes set Detail to Fine or higher and re-apply.'
        : '') +
      (subdivide
        ? ` Mesh refined to ${painter.triCount.toLocaleString()} triangles (undo history cleared).`
        : ' Undo with Ctrl+Z.')
    );
  } catch (err) {
    console.error(err);
    setStatus(`Decal failed: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-decal-remove').addEventListener('click', () => {
  decal.img = null;
  decal.originalImg = null;
  if (decal.originalUrl) URL.revokeObjectURL(decal.originalUrl);
  decal.originalUrl = null;
  decalOv.style.display = 'none';
  document.getElementById('decal-controls').style.display = 'none';
  setStatus('Decal removed.');
});

// ---- image projection ----

document.getElementById('proj-tolerance').addEventListener('input', (e) => {
  document.getElementById('proj-tolerance-val').textContent = e.target.value;
});
const deshadeToggle = document.getElementById('proj-deshade');
setDeshade(deshadeToggle.checked);
deshadeToggle.addEventListener('change', () => setDeshade(deshadeToggle.checked));

document.getElementById('btn-proj-snapshot').addEventListener('click', async () => {
  if (!painter.mesh) return setStatus('Open an STL before taking a snapshot.');
  const blob = await projection.capture(viewer);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${modelName}-snapshot.png`;
  a.click();
  URL.revokeObjectURL(a.href);
  document.getElementById('btn-proj-import').disabled = false;
  document.getElementById('btn-proj-return').disabled = false;
  setStatus('Snapshot saved. Paint on it with your filament colors (don’t crop!), then import it. You can keep working meanwhile — the camera pose is remembered.');
});

document.getElementById('btn-proj-return').addEventListener('click', () => {
  if (!projection.active) return;
  viewer.applyViewState(projection.data.viewState);
  document.getElementById('btn-ortho').classList.toggle('active', !viewer.camera.isPerspectiveCamera);
  setStatus('Camera returned to the snapshot position.');
});

document.getElementById('btn-proj-import').addEventListener('click', () => {
  document.getElementById('proj-file').click();
});

document.getElementById('proj-file').addEventListener('change', async () => {
  const file = document.getElementById('proj-file').files[0];
  document.getElementById('proj-file').value = '';
  if (!file || !projection.active) return;
  setStatus('Projecting image onto the model…');
  try {
    const img = await createImageBitmap(file);
    painter.beginStroke();
    const c = await projection.apply(painter, img, {
      tolerance: parseFloat(document.getElementById('proj-tolerance').value),
      changedOnly: document.getElementById('proj-changed-only').checked,
      autoPalette: document.getElementById('proj-auto-colors').checked,
      onProgress: (f) => setStatus(`Projecting image — ${Math.round(f * 100)}%…`),
    });
    painter.endStroke();
    if (!c) return setStatus('Projection failed — no snapshot pose stored.');
    if (c.created > 0) renderGroups();
    setStatus(`Projected: ${c.applied} triangles painted · ${c.unchanged} unchanged · ${c.noMatch} no color match · ${c.hidden} facing away/hidden.` +
      (c.created > 0 ? ` Created ${c.created} color group(s) from the image.` : '') +
      ' Undo with Ctrl+Z if needed.');
  } catch (err) {
    console.error(err);
    setStatus(`Projection failed: ${err.message}`);
  }
});

// ---- region ops ----

function doGrow() {
  if (!painter.mesh) return;
  painter.beginStroke();
  const n = painter.grow();
  painter.endStroke();
  setStatus(`Grew "${painter.groups[painter.activeGroup].name}" by ${n} triangles.`);
}
function doShrink() {
  if (!painter.mesh) return;
  painter.beginStroke();
  const n = painter.shrink();
  painter.endStroke();
  setStatus(`Shrank "${painter.groups[painter.activeGroup].name}" by ${n} triangles.`);
}
document.getElementById('btn-grow').addEventListener('click', doGrow);
document.getElementById('btn-shrink').addEventListener('click', doShrink);
document.getElementById('btn-despeckle').addEventListener('click', () => {
  if (!painter.mesh) return;
  // anything under ~0.05% of the mesh (at least 8 tris) counts as a speck
  const minSize = Math.max(8, Math.round(painter.triCount * 0.0005));
  painter.beginStroke();
  const { islands, tris } = painter.despeckle(minSize);
  painter.endStroke();
  setStatus(islands
    ? `Despeckle: absorbed ${islands} leftover island(s), ${tris} triangles (smaller than ${minSize}).`
    : `Despeckle: no islands smaller than ${minSize} triangles found.`);
});
document.getElementById('btn-clear-blockers').addEventListener('click', () => {
  if (!painter.mesh) return;
  painter.clearBlockers();
  setStatus('Cleared all blockers.');
});

// ---- keyboard ----

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  // Blender-style numpad views: 1 front (Ctrl: back), 3 right (Ctrl: left),
  // 7 top (Ctrl: bottom), 5 toggles ortho
  if (e.code.startsWith('Numpad')) {
    const views = { Numpad1: ['front', 'back'], Numpad3: ['right', 'left'], Numpad7: ['top', 'bottom'] };
    if (views[e.code]) {
      viewer.setView(views[e.code][e.ctrlKey ? 1 : 0]);
      setStatus(`${views[e.code][e.ctrlKey ? 1 : 0]} view.`);
      e.preventDefault();
      return;
    }
    if (e.code === 'Numpad5') {
      document.getElementById('btn-ortho').click();
      e.preventDefault();
      return;
    }
    if (e.code === 'Numpad0') {
      viewer.setView('home');
      setStatus('Home view.');
      e.preventDefault();
      return;
    }
  }
  if (e.key === 'Home') {
    viewer.setView('home');
    setStatus('Home view.');
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && textPlacing) {
    endTextPlacement();
    setStatus('Curved text cancelled.');
    e.preventDefault();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'b') setTool('brush');
  if (k === 'f') setTool('fill');
  if (k === 'i') setTool('island');
  if (k === 'x') setTool('blocker');
  if (k === 'l') setTool('line');
  if (e.key === 'Backspace' && tool === 'line' && linePoints.length) {
    removeLastLinePoint();
    setStatus(`Removed last point — ${linePoints.length} left${lineRedo.length ? ' (Ctrl+Y to restore)' : ''}.`);
    e.preventDefault();
    return;
  }
  if (e.key === '[') adjustBrush(-1);
  if (e.key === ']') adjustBrush(1);
  if (e.key === '+' || e.key === '=') doGrow();
  if (e.key === '-') doShrink();
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) {
    // while a line is being placed, Ctrl+Z removes the last point instead of
    // undoing the previous committed stroke
    if (tool === 'line' && linePoints.length) {
      removeLastLinePoint();
      setStatus(`Removed last point — ${linePoints.length} left${lineRedo.length ? ' (Ctrl+Y to restore)' : ''}.`);
    } else if (painter.undo()) {
      setStatus('Undid stroke.');
    }
    e.preventDefault();
  }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) {
    if (tool === 'line' && lineRedo.length) {
      restoreLinePoint();
      setStatus(`Restored point — ${linePoints.length} placed.`);
    } else if (painter.redo()) {
      setStatus('Redid stroke.');
    }
    e.preventDefault();
  }
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= painter.groups.length) {
    painter.activeGroup = n - 1;
    renderGroups();
  }
});

function adjustBrush(dir) {
  const slider = document.getElementById('brush-size');
  slider.value = Math.min(30, Math.max(0.5, brushRadius + dir));
  slider.dispatchEvent(new Event('input'));
}

// ---- painting input ----

const canvas = viewer.renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !painter.mesh || refining) return;
  const hit = viewer.pick(e);
  if (!hit) return;
  if (textPlacing) {
    textPath.push({ point: hit.point.clone(), tri: hit.faceIndex });
    refreshTextBaseline();
    setStatus(`Curved text baseline: ${textPath.length} point(s). Add more or "Apply curved text".`);
    return;
  }
  if (tool === 'line') {
    lineRedo = []; // a fresh point starts a new branch
    linePoints.push({ point: hit.point.clone(), tri: hit.faceIndex });
    rebuildLinePath();
    refreshLinePreview();
    setStatus(`Line: ${linePoints.length} point(s). Commit with "Paint line" or "Block line".`);
    return;
  }
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no valid pointerId */ }
  const through = document.getElementById('brush-through').checked;
  painter.beginStroke();
  if (tool === 'brush') {
    dragMode = 'brush';
    strokePath = [hit.point.clone()];
    strokeErase = e.altKey;
    painter.brush(hit.point, brushRadius, hit.faceIndex, through, e.altKey ? 0 : painter.activeGroup);
  } else if (tool === 'blocker') {
    dragMode = 'blocker';
    strokePath = [hit.point.clone()];
    strokeErase = e.altKey;
    painter.blockerBrush(hit.point, brushRadius, hit.faceIndex, e.altKey, through);
  } else if (tool === 'fill') {
    if (painter.startScrubFill(hit.faceIndex)) {
      dragMode = 'scrub';
      scrubStartX = e.clientX;
      scrubLimit = fillAngle;
      const n = painter.scrubTo(scrubLimit);
      setStatus(`Fill reach ${Math.round(scrubLimit)}° — ${n} triangles. Drag right/left to adjust, release to commit.`);
    } else {
      painter.endStroke();
      setStatus('Cannot fill from a blocker.');
    }
  } else if (tool === 'island') {
    painter.islandFill(hit.faceIndex);
    painter.endStroke();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (dragMode === 'scrub') {
    scrubLimit = Math.max(0, Math.min(360, fillAngle + (e.clientX - scrubStartX) * 0.25));
    const n = painter.scrubTo(scrubLimit);
    setStatus(`Fill reach ${Math.round(scrubLimit)}° — ${n} triangles. Release to commit.`);
    return;
  }
  const hit = viewer.pick(e);
  const showCursor = tool === 'brush' || tool === 'blocker';
  const cursorColor = e.altKey ? 0xff6060 : (tool === 'blocker' ? 0xc060ff : 0xffffff);
  viewer.updateBrushCursor(showCursor ? hit : null, brushRadius, cursorColor);
  if (!hit) return;
  const through = document.getElementById('brush-through').checked;
  if (dragMode === 'brush' || dragMode === 'blocker') {
    const last = strokePath[strokePath.length - 1];
    if (!last || last.distanceTo(hit.point) > brushRadius * 0.4) strokePath.push(hit.point.clone());
  }
  if (dragMode === 'brush') painter.brush(hit.point, brushRadius, hit.faceIndex, through, e.altKey ? 0 : painter.activeGroup);
  else if (dragMode === 'blocker') painter.blockerBrush(hit.point, brushRadius, hit.faceIndex, e.altKey, through);
});

window.addEventListener('pointerup', async () => {
  if (!dragMode) return;
  const mode = dragMode;
  dragMode = null;
  if (mode === 'scrub') {
    painter.endScrubFill();
    painter.endStroke();
    return;
  }
  // brush / blocker stroke: optionally re-apply with crisp subdivided edges
  const wantSubdiv =
    document.getElementById('stroke-subdiv').checked && !strokeErase && strokePath.length > 0;
  if (!wantSubdiv) {
    painter.endStroke();
    strokePath = [];
    return;
  }
  refining = true;
  try {
    painter.cancelStroke(); // revert the whole-triangle preview
    await painter.refineStroke(strokePath, brushRadius, {
      rounds: 3,
      onProgress: (f) => setStatus(`Refining stroke edges — ${Math.round(f * 100)}%…`),
    });
    painter.paintPolyline(strokePath, brushRadius * 2, mode === 'blocker');
    setStatus(`Stroke applied with crisp edges — mesh now ${painter.triCount.toLocaleString()} triangles (undo history cleared).`);
  } catch (err) {
    console.error(err);
    setStatus(`Stroke refinement failed: ${err.message}`);
  } finally {
    refining = false;
    strokePath = [];
  }
});

// ---- group panel ----

function savePalette() {
  try {
    localStorage.setItem('multipaint-palette',
      JSON.stringify(painter.groups.map((g) => ({ name: g.name, color: g.color }))));
  } catch { /* storage unavailable — palette just won't persist */ }
}

function restorePalette() {
  try {
    const saved = JSON.parse(localStorage.getItem('multipaint-palette') || 'null');
    if (Array.isArray(saved) && saved.length >= 1 && saved.length <= 16) {
      painter.groups = saved.map((s) => ({
        name: String(s.name || 'Color'),
        color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#d9d9d9',
      }));
      painter.activeGroup = Math.min(1, painter.groups.length - 1);
    }
  } catch { /* corrupt storage — keep defaults */ }
}

function renderGroups() {
  groupsEl.innerHTML = '';
  painter.groups.forEach((g, i) => {
    const row = document.createElement('div');
    row.className = 'group-row' + (i === painter.activeGroup ? ' active' : '');

    const slot = document.createElement('span');
    slot.className = 'slot';
    slot.textContent = i + 1;

    const color = document.createElement('input');
    color.type = 'color';
    color.value = g.color;
    color.addEventListener('input', () => {
      g.color = color.value;
      painter.refreshGroupColor(i);
      savePalette();
    });

    const name = document.createElement('input');
    name.type = 'text';
    name.value = g.name;
    name.addEventListener('change', () => {
      g.name = name.value;
      savePalette();
    });
    name.addEventListener('click', (e) => e.stopPropagation());

    row.append(slot, color, name);

    if (i > 0) {
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Remove group (painted faces return to base)';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        painter.removeGroup(i);
        renderGroups();
      });
      row.append(del);
    }

    row.addEventListener('click', () => {
      painter.activeGroup = i;
      renderGroups();
    });

    groupsEl.append(row);
  });
  savePalette();
}

document.getElementById('btn-add-group').addEventListener('click', () => {
  if (painter.groups.length >= 16) return setStatus('Slicers support at most 16 filaments.');
  painter.addGroup();
  renderGroups();
});

restorePalette();
renderGroups();

// ---- export ----

document.getElementById('btn-export').addEventListener('click', () => {
  if (!painter.mesh) return setStatus('Nothing to export — open an STL first.');
  setStatus('Exporting…');
  try {
    const mode = document.getElementById('export-mode').value;
    const exporter = mode === 'parts' ? exportMultiPart3MF : exportPainted3MF;
    const bytes = exporter(
      painter.mesh.geometry,
      painter.triGroup,
      painter.groups,
      modelName
    );
    const blob = new Blob([bytes], { type: 'model/3mf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${modelName}-painted.3mf`;
    a.click();
    URL.revokeObjectURL(a.href);
    const used = painter.groupStats().filter((c) => c > 0).length;
    setStatus(mode === 'parts'
      ? `Exported ${modelName}-painted.3mf with ${used} part(s). Import it in Orca/Bambu Studio.`
      : `Exported ${modelName}-painted.3mf as one solid with paint data (${used} color(s)). Import it in Orca/Bambu Studio.`);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message}`);
  }
});
