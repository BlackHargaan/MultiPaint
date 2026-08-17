import { zipSync, strToU8 } from 'fflate';

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n` +
  ` <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n` +
  ` <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n` +
  ` <Default Extension="config" ContentType="text/xml"/>\n` +
  `</Types>\n`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
  ` <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n` +
  `</Relationships>\n`;

/**
 * Export the painted mesh as a 3MF where each filament group becomes one mesh
 * part inside a single object. Includes Orca/Bambu `model_settings.config`
 * metadata so parts import with their filament slot already assigned.
 *
 * @param geometry non-indexed BufferGeometry (positions only are used)
 * @param triGroup Uint16Array, group id per triangle
 * @param groups   [{ name, color }] — index = filament slot - 1
 * @returns Uint8Array zip bytes
 */
export function exportMultiPart3MF(geometry, triGroup, groups, modelName = 'MultiPaint Model') {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;

  // bucket triangles by group, skipping empty groups
  const trisByGroup = groups.map(() => []);
  for (let t = 0; t < triCount; t++) trisByGroup[triGroup[t]].push(t);

  const parts = []; // { objectId, groupIndex }
  let nextId = 1;
  const objectXml = [];

  for (let g = 0; g < groups.length; g++) {
    const tris = trisByGroup[g];
    if (tris.length === 0) continue;
    const objectId = nextId++;
    parts.push({ objectId, groupIndex: g });
    objectXml.push(buildMeshObjectXml(objectId, pos, tris));
  }

  const parentId = nextId++;
  const components = parts
    .map((p) => `   <component objectid="${p.objectId}"/>`)
    .join('\n');
  objectXml.push(
    `  <object id="${parentId}" type="model">\n` +
    `   <components>\n${components}\n   </components>\n` +
    `  </object>`
  );

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    ` <metadata name="Application">MultiPaint</metadata>\n` +
    ` <metadata name="Title">${escapeXml(modelName)}</metadata>\n` +
    ` <resources>\n${objectXml.join('\n')}\n </resources>\n` +
    ` <build>\n  <item objectid="${parentId}"/>\n </build>\n` +
    `</model>\n`;

  // Orca/Bambu part settings: extruder = filament slot (1-based group index)
  const partXml = parts
    .map((p) =>
      `  <part id="${p.objectId}" subtype="normal_part">\n` +
      `    <metadata key="name" value="${escapeXml(groups[p.groupIndex].name)}"/>\n` +
      `    <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
      `    <metadata key="extruder" value="${p.groupIndex + 1}"/>\n` +
      `  </part>`
    )
    .join('\n');
  const modelSettings =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    `  <object id="${parentId}">\n` +
    `    <metadata key="name" value="${escapeXml(modelName)}"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    partXml + '\n' +
    `  </object>\n` +
    `</config>\n`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(modelSettings),
  });
}

/**
 * Export the painted mesh as a single untouched solid with per-triangle
 * `paint_color` attributes — the same mechanism Orca/Bambu use for their own
 * paint tool. Geometry is identical to the input model (no splitting), so no
 * new non-manifold edges or empty layers can appear.
 *
 * Encoding (BambuStudio TriangleSelector::serialize, unsplit triangles):
 * state 1..2 -> single hex digit (state << 2); state >= 3 -> "C" marker nibble
 * plus value nibbles, hex string written most-significant-nibble first.
 * State N paints filament slot N; unpainted triangles use the part's extruder.
 */
export function exportPainted3MF(geometry, triGroup, groups, modelName = 'MultiPaint Model') {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;

  const vertLines = [];
  const triLines = [];
  const vertMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const idx = [0, 0, 0];
    for (let v = 0; v < 3; v++) {
      const x = pos.getX(t * 3 + v);
      const y = pos.getY(t * 3 + v);
      const z = pos.getZ(t * 3 + v);
      const key = x + '_' + y + '_' + z;
      let vi = vertMap.get(key);
      if (vi === undefined) {
        vi = vertMap.size;
        vertMap.set(key, vi);
        vertLines.push(`     <vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`);
      }
      idx[v] = vi;
    }
    // group g prints on filament slot g+1; slot 1 is the part default (unpainted)
    const attr = triGroup[t] > 0 ? ` paint_color="${paintColorString(triGroup[t] + 1)}"` : '';
    triLines.push(`     <triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"${attr}/>`);
  }

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    ` <metadata name="Application">MultiPaint</metadata>\n` +
    ` <metadata name="Title">${escapeXml(modelName)}</metadata>\n` +
    ` <resources>\n` +
    `  <object id="1" type="model">\n` +
    `   <mesh>\n` +
    `    <vertices>\n${vertLines.join('\n')}\n    </vertices>\n` +
    `    <triangles>\n${triLines.join('\n')}\n    </triangles>\n` +
    `   </mesh>\n` +
    `  </object>\n` +
    `  <object id="2" type="model">\n` +
    `   <components>\n   <component objectid="1"/>\n   </components>\n` +
    `  </object>\n` +
    ` </resources>\n` +
    ` <build>\n  <item objectid="2"/>\n </build>\n` +
    `</model>\n`;

  const modelSettings =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n` +
    `  <object id="2">\n` +
    `    <metadata key="name" value="${escapeXml(modelName)}"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    `  <part id="1" subtype="normal_part">\n` +
    `    <metadata key="name" value="${escapeXml(modelName)}"/>\n` +
    `    <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    `  </part>\n` +
    `  </object>\n` +
    `</config>\n`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(modelSettings),
  });
}

/**
 * Export several painted objects as one 3MF, each as its own build item so the
 * slicer opens them as distinct, already-painted objects on the plate. Each
 * object keeps its own paint (paint_color) and is written at its original world
 * position (display coords + origin offset).
 *
 * @param objects [{ name, geometry, triGroup, origin:{x,y,z} }]
 * @param groups  filament palette (shared across objects)
 */
export function exportProject3MF(objects, groups, modelName = 'MultiPaint Model') {
  const resourceXml = [];
  const buildItems = [];
  const settingsObjs = [];
  let nextId = 1;
  for (const obj of objects) {
    const meshId = nextId++;
    resourceXml.push(buildPaintedMeshObject(meshId, obj));
    const itemId = nextId++;
    resourceXml.push(
      `  <object id="${itemId}" type="model">\n` +
      `   <components>\n    <component objectid="${meshId}"/>\n   </components>\n` +
      `  </object>`
    );
    buildItems.push(`  <item objectid="${itemId}"/>`);
    const name = escapeXml(obj.name || `Object ${meshId}`);
    settingsObjs.push(
      `  <object id="${itemId}">\n` +
      `    <metadata key="name" value="${name}"/>\n` +
      `    <metadata key="extruder" value="1"/>\n` +
      `  <part id="${meshId}" subtype="normal_part">\n` +
      `    <metadata key="name" value="${name}"/>\n` +
      `    <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
      `    <metadata key="extruder" value="1"/>\n` +
      `  </part>\n` +
      `  </object>`
    );
  }

  const model =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    ` <metadata name="Application">MultiPaint</metadata>\n` +
    ` <metadata name="Title">${escapeXml(modelName)}</metadata>\n` +
    ` <resources>\n${resourceXml.join('\n')}\n </resources>\n` +
    ` <build>\n${buildItems.join('\n')}\n </build>\n` +
    `</model>\n`;

  const modelSettings =
    `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settingsObjs.join('\n')}\n</config>\n`;

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(modelSettings),
  });
}

/** One `<object>` with an indexed painted mesh, vertices shifted by origin. */
function buildPaintedMeshObject(objectId, obj) {
  const pos = obj.geometry.attributes.position;
  const triCount = pos.count / 3;
  const ox = obj.origin ? obj.origin.x : 0;
  const oy = obj.origin ? obj.origin.y : 0;
  const oz = obj.origin ? obj.origin.z : 0;
  const vertLines = [];
  const triLines = [];
  const vertMap = new Map();
  for (let t = 0; t < triCount; t++) {
    const idx = [0, 0, 0];
    for (let v = 0; v < 3; v++) {
      const x = pos.getX(t * 3 + v) + ox, y = pos.getY(t * 3 + v) + oy, z = pos.getZ(t * 3 + v) + oz;
      const key = x + '_' + y + '_' + z;
      let vi = vertMap.get(key);
      if (vi === undefined) {
        vi = vertMap.size;
        vertMap.set(key, vi);
        vertLines.push(`     <vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`);
      }
      idx[v] = vi;
    }
    const g = obj.triGroup[t];
    const attr = g > 0 ? ` paint_color="${paintColorString(g + 1)}"` : '';
    triLines.push(`     <triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"${attr}/>`);
  }
  return (
    `  <object id="${objectId}" type="model">\n` +
    `   <mesh>\n` +
    `    <vertices>\n${vertLines.join('\n')}\n    </vertices>\n` +
    `    <triangles>\n${triLines.join('\n')}\n    </triangles>\n` +
    `   </mesh>\n` +
    `  </object>`
  );
}

/** Per-triangle paint_color value for filament state N (1-based). */
function paintColorString(state) {
  if (state <= 2) return (state << 2).toString(16).toUpperCase(); // 1 -> "4", 2 -> "8"
  let m = state - 3;
  const nibbles = ['C']; // 0b1100 marker, then value nibbles of (state - 3)
  while (m >= 15) { nibbles.push('F'); m -= 15; }
  nibbles.push(m.toString(16).toUpperCase());
  return nibbles.reverse().join(''); // 3 -> "0C", 4 -> "1C", 18 -> "0FC"
}

/** Build one <object> with an indexed mesh from a list of triangle indices. */
function buildMeshObjectXml(objectId, pos, tris) {
  const vertLines = [];
  const triLines = [];
  const vertMap = new Map(); // coordinate key -> local vertex index

  for (const t of tris) {
    const idx = [0, 0, 0];
    for (let v = 0; v < 3; v++) {
      const x = pos.getX(t * 3 + v);
      const y = pos.getY(t * 3 + v);
      const z = pos.getZ(t * 3 + v);
      const key = x + '_' + y + '_' + z;
      let vi = vertMap.get(key);
      if (vi === undefined) {
        vi = vertMap.size;
        vertMap.set(key, vi);
        vertLines.push(`     <vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}"/>`);
      }
      idx[v] = vi;
    }
    triLines.push(`     <triangle v1="${idx[0]}" v2="${idx[1]}" v3="${idx[2]}"/>`);
  }

  return (
    `  <object id="${objectId}" type="model">\n` +
    `   <mesh>\n` +
    `    <vertices>\n${vertLines.join('\n')}\n    </vertices>\n` +
    `    <triangles>\n${triLines.join('\n')}\n    </triangles>\n` +
    `   </mesh>\n` +
    `  </object>`
  );
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/\.?0+$/, '');
}

function escapeXml(s) {
  return s.replace(/[<>&"']/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}
