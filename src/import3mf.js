import { unzipSync, strFromU8 } from 'fflate';

/**
 * Import a 3MF: geometry plus any paint it carries.
 * Understands:
 *  - plain core-spec 3MF (including MultiPaint "painted model" exports)
 *  - Bambu/Orca project 3MFs (production extension: objects split into
 *    3D/Objects/*.model referenced via p:path components, with transforms)
 *  - per-triangle `paint_color` attributes (BambuStudio TriangleSelector
 *    encoding; split triangles resolve to their dominant painted state)
 *  - Metadata/model_settings.config part→extruder assignments (MultiPaint
 *    "separate parts" exports import back as their filament groups)
 *  - Metadata/project_settings.config filament colors, when present
 *
 * Each top-level build item becomes a separate object (its components merged
 * into that object's soup), so multi-object files stay multi-object.
 *
 * @returns { objects: [{ name, positions: Float32Array, triGroup: Uint16Array }],
 *            filamentColors: string[]|null }
 */
export function parse3MF(arrayBuffer) {
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const dom = (path) => {
    const data = files[path.replace(/^\//, '')];
    if (!data) return null;
    return new DOMParser().parseFromString(strFromU8(data), 'application/xml');
  };

  const mainPath = findMainModelPath(files);
  const mainDoc = dom(mainPath);
  if (!mainDoc) throw new Error('No 3D model found in the 3MF archive.');

  // part-id -> extruder from Bambu/Orca model settings ("separate parts" mode)
  const partExtruder = parseModelSettings(files);
  const partName = parseModelSettingsNames(files);

  // object registries per model file (lazy-loaded for p:path components)
  const docs = new Map([[mainPath, mainDoc]]);
  const getDoc = (path) => {
    if (!docs.has(path)) docs.set(path, dom(path));
    return docs.get(path);
  };

  // accumulate one object's triangle soup, following components recursively
  const emitObject = (positions, triGroups, doc, objectId, matrix, path) => {
    const obj = doc.querySelector(`resources > object[id="${objectId}"]`);
    if (!obj) return;
    const mesh = obj.querySelector('mesh');
    if (mesh) {
      const verts = [];
      for (const v of mesh.querySelectorAll('vertices > vertex')) {
        verts.push([
          parseFloat(v.getAttribute('x')),
          parseFloat(v.getAttribute('y')),
          parseFloat(v.getAttribute('z')),
        ]);
      }
      const partGroup = partExtruder.get(String(objectId));
      for (const t of mesh.querySelectorAll('triangles > triangle')) {
        const idx = [t.getAttribute('v1'), t.getAttribute('v2'), t.getAttribute('v3')];
        for (const iStr of idx) positions.push(...applyMatrix(matrix, verts[+iStr]));
        const paint = t.getAttribute('paint_color') || t.getAttribute('slic3rpe:mmu_segmentation');
        let group = 0;
        if (paint) {
          const state = decodePaintState(paint);
          if (state > 0) group = state - 1; // state N = filament slot N = group N-1
        } else if (partGroup !== undefined) {
          group = partGroup;
        }
        triGroups.push(group);
      }
    }
    for (const comp of obj.querySelectorAll('components > component')) {
      const childId = comp.getAttribute('objectid');
      const childPathAttr = comp.getAttribute('p:path') || comp.getAttributeNS('*', 'path');
      const childMatrix = composeMatrix(matrix, parseTransform(comp.getAttribute('transform')));
      const childDoc = childPathAttr ? getDoc(childPathAttr.replace(/^\//, '')) : doc;
      const childPath = childPathAttr ? childPathAttr.replace(/^\//, '') : path;
      if (childDoc) emitObject(positions, triGroups, childDoc, childId, childMatrix, childPath);
    }
  };

  const objects = [];
  const items = [...mainDoc.querySelectorAll('build > item')];
  items.forEach((item, i) => {
    const positions = [];
    const triGroups = [];
    const objectId = item.getAttribute('objectid');
    emitObject(positions, triGroups, mainDoc, objectId, parseTransform(item.getAttribute('transform')), mainPath);
    const obj = finalizeObject(positions, triGroups,
      partName.get(String(objectId)) || objectNameOf(mainDoc, objectId) || `Object ${i + 1}`);
    if (obj) objects.push(obj);
  });
  if (!objects.length) throw new Error('The 3MF contains no printable mesh.');

  return { objects, filamentColors: parseFilamentColors(files) };
}

/** Drop degenerate triangles and pack into typed arrays; null if empty. */
function finalizeObject(positions, triGroups, name) {
  if (!positions.length) return null;
  const raw = Float32Array.from(positions);
  const triCount = raw.length / 9;
  const eq = (i, j) => raw[i] === raw[j] && raw[i + 1] === raw[j + 1] && raw[i + 2] === raw[j + 2];
  const keep = [];
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    if (!(eq(o, o + 3) || eq(o + 3, o + 6) || eq(o, o + 6))) keep.push(t);
  }
  if (!keep.length) return null;
  const outPos = new Float32Array(keep.length * 9);
  const outGroup = new Uint16Array(keep.length);
  keep.forEach((t, i) => {
    outPos.set(raw.subarray(t * 9, t * 9 + 9), i * 9);
    outGroup[i] = triGroups[t];
  });
  return { name, positions: outPos, triGroup: outGroup };
}

/** An object element's display name attribute, if any. */
function objectNameOf(doc, objectId) {
  const obj = doc.querySelector(`resources > object[id="${objectId}"]`);
  return obj ? obj.getAttribute('name') : null;
}

function findMainModelPath(files) {
  // resolve via _rels/.rels when possible, else the conventional path
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = strFromU8(rels).match(/Target="\/?([^"]+\.model)"/i);
    if (m && files[m[1]]) return m[1];
  }
  if (files['3D/3dmodel.model']) return '3D/3dmodel.model';
  const any = Object.keys(files).find((k) => k.endsWith('.model'));
  if (!any) throw new Error('No .model file in the 3MF archive.');
  return any;
}

/** 3MF transform attr: 12 floats, columns of a 4x3 row-major matrix. */
function parseTransform(attr) {
  if (!attr) return null;
  const m = attr.trim().split(/\s+/).map(Number);
  return m.length === 12 ? m : null;
}

function composeMatrix(a, b) {
  if (!a) return b;
  if (!b) return a;
  // both are 3MF 12-float matrices [r00 r01 r02 r10 r11 r12 r20 r21 r22 tx ty tz]
  const out = new Array(12);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col];
    }
  }
  for (let col = 0; col < 3; col++) {
    out[9 + col] =
      a[9] * b[col] + a[10] * b[3 + col] + a[11] * b[6 + col] + b[9 + col];
  }
  return out;
}

function applyMatrix(m, p) {
  if (!m) return p;
  return [
    p[0] * m[0] + p[1] * m[3] + p[2] * m[6] + m[9],
    p[0] * m[1] + p[1] * m[4] + p[2] * m[7] + m[10],
    p[0] * m[2] + p[1] * m[5] + p[2] * m[8] + m[11],
  ];
}

/**
 * Decode a paint_color / mmu_segmentation triangle string to its dominant
 * painted state (0 = unpainted). Mirrors TriangleSelector::serialize: the
 * hex string is nibble-reversed, bits are LSB-first within each nibble;
 * split triangles recurse, and we take the area-weighted majority leaf.
 */
export function decodePaintState(str) {
  const nibbles = [];
  for (let i = str.length - 1; i >= 0; i--) nibbles.push(parseInt(str[i], 16));
  let pos = 0;
  const readBits = (n) => {
    let v = 0;
    for (let b = 0; b < n; b++) {
      const nib = nibbles[(pos / 4) | 0] ?? 0;
      v |= ((nib >> (pos % 4)) & 1) << b;
      pos++;
    }
    return v;
  };
  const tally = new Map();
  const walk = (weight) => {
    const splitSides = readBits(2);
    if (splitSides === 0) {
      let state = readBits(2);
      if (state === 3) {
        let acc = 0;
        let nib = readBits(4);
        while (nib === 15) { acc += 15; nib = readBits(4); }
        state = 3 + acc + nib;
      }
      tally.set(state, (tally.get(state) || 0) + weight);
    } else {
      readBits(2); // special side — irrelevant for majority state
      for (let c = 0; c <= splitSides; c++) walk(weight / (splitSides + 1));
    }
  };
  walk(1);
  let best = 0, bw = -1;
  for (const [s, w] of tally) if (w > bw) { bw = w; best = s; }
  return best;
}

/** Bambu/Orca model_settings.config: map part object-id -> group (extruder-1). */
function parseModelSettings(files) {
  const map = new Map();
  const data = files['Metadata/model_settings.config'];
  if (!data) return map;
  try {
    const doc = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
    for (const part of doc.querySelectorAll('part')) {
      const id = part.getAttribute('id');
      for (const meta of part.querySelectorAll('metadata')) {
        if (meta.getAttribute('key') === 'extruder') {
          const ext = parseInt(meta.getAttribute('value'), 10);
          if (ext >= 1) map.set(id, ext - 1);
        }
      }
    }
  } catch { /* optional metadata — ignore malformed */ }
  return map;
}

/** Bambu/Orca model_settings.config: map object-id -> display name. */
function parseModelSettingsNames(files) {
  const map = new Map();
  const data = files['Metadata/model_settings.config'];
  if (!data) return map;
  try {
    const doc = new DOMParser().parseFromString(strFromU8(data), 'application/xml');
    for (const obj of doc.querySelectorAll('object')) {
      const id = obj.getAttribute('id');
      for (const meta of obj.querySelectorAll(':scope > metadata')) {
        if (meta.getAttribute('key') === 'name') map.set(id, meta.getAttribute('value'));
      }
    }
  } catch { /* optional metadata — ignore malformed */ }
  return map;
}

/** Bambu/Orca project_settings.config (JSON): filament display colors. */
function parseFilamentColors(files) {
  const data = files['Metadata/project_settings.config'];
  if (!data) return null;
  try {
    const cfg = JSON.parse(strFromU8(data));
    const cols = cfg.filament_colour || cfg.filament_color;
    if (Array.isArray(cols) && cols.length) {
      return cols.map((c) => (c.startsWith('#') ? c : '#' + c).slice(0, 7).toLowerCase());
    }
  } catch { /* optional metadata — ignore malformed */ }
  return null;
}
