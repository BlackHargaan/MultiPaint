import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

/**
 * Project persistence. Two channels:
 *  - IndexedDB autosave (resume where you left off after a reload / relaunch)
 *  - a portable .mpaint file (a zip of a JSON manifest + raw geometry/paint
 *    buffers) for explicit Save/Open and moving between machines.
 *
 * A project is { version, groups, activeIndex, objects:[{ name, origin,
 * positions:Float32Array, triGroup:Uint16Array, blocked:Uint8Array }] } where
 * positions are the plate-centered display coords (origin restores world pos).
 */

const PROJECT_VERSION = 1;

// ---- IndexedDB ----

const DB_NAME = 'multipaint';
const STORE = 'projects';
const AUTOSAVE_KEY = 'autosave';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store the project under the autosave key (typed arrays are cloned as-is). */
export async function idbSaveProject(project) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(project, AUTOSAVE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}

/** Load the autosaved project, or null if none. */
export async function idbLoadProject() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(AUTOSAVE_KEY);
    req.onsuccess = () => { db.close(); resolve(req.result || null); };
    req.onerror = () => reject(req.error);
  });
}

export async function idbClearProject() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(AUTOSAVE_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
  });
}

// ---- portable .mpaint file (zip of manifest + raw buffers) ----

/** Bytes of a typed array as a plain Uint8Array (copied, 0-offset). */
function bytes(arr) {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength).slice();
}

export function packProjectFile(project) {
  const manifest = {
    version: PROJECT_VERSION,
    app: 'MultiPaint',
    groups: project.groups,
    activeIndex: project.activeIndex,
    objects: project.objects.map((o, i) => ({
      name: o.name,
      origin: o.origin,
      triCount: o.triCount ?? (o.triGroup ? o.triGroup.length : 0),
      vertCount: o.positions.length / 3,
      dir: `obj${i}`,
    })),
  };
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
  project.objects.forEach((o, i) => {
    files[`obj${i}/pos.f32`] = bytes(o.positions);
    files[`obj${i}/grp.u16`] = bytes(o.triGroup);
    files[`obj${i}/blk.u8`] = bytes(o.blocked);
  });
  return zipSync(files, { level: 6 });
}

export function unpackProjectFile(arrayBuffer) {
  const files = unzipSync(new Uint8Array(arrayBuffer));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const f32 = (u8) => new Float32Array(u8.slice().buffer);
  const u16 = (u8) => new Uint16Array(u8.slice().buffer);
  const objects = manifest.objects.map((m, i) => ({
    name: m.name,
    origin: m.origin,
    positions: f32(files[`${m.dir ?? `obj${i}`}/pos.f32`]),
    triGroup: u16(files[`${m.dir ?? `obj${i}`}/grp.u16`]),
    blocked: new Uint8Array(files[`${m.dir ?? `obj${i}`}/blk.u8`].slice().buffer),
  }));
  return { version: manifest.version, groups: manifest.groups, activeIndex: manifest.activeIndex || 0, objects };
}
