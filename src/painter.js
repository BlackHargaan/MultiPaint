import * as THREE from 'three';
import { refineMesh } from './subdivide.js';

const DEFAULT_COLORS = ['#d9d9d9', '#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1'];
const BLOCKER_TINT = new THREE.Color(0.55, 0.2, 0.75);
const CONCAVE_COST_MULT = 2.5; // valleys (where emblems meet the surface) are harder to cross

/**
 * Owns per-triangle group assignments and the painting tools.
 * Group 0 is the base; groups map 1:1 to slicer filament slots (1-based).
 */
export class Painter {
  constructor() {
    this.mesh = null;
    this.triGroup = null;      // Uint16Array, one entry per triangle
    this.blocked = null;       // Uint8Array, 1 = fill barrier
    this.adjacency = null;     // Int32Array, 3 neighbor tri indices per triangle (-1 = open edge)
    this.triNormals = null;    // Float32Array cache, 3 per triangle
    this.triCentroids = null;  // Float32Array cache, 3 per triangle
    this.triCount = 0;
    this.groups = [
      { name: 'Base', color: DEFAULT_COLORS[0] },
      { name: 'Color 2', color: DEFAULT_COLORS[1] },
    ];
    this.activeGroup = 1;
    this.undoStack = [];       // array of { group: Map<tri,prev>, blocked: Map<tri,prev> }
    this.redoStack = [];
    this._strokeChanges = null;
    this._scrub = null;        // active scrubbable-fill state
  }

  setMesh(mesh) {
    this.mesh = mesh;
    this.triCount = mesh.geometry.attributes.position.count / 3;
    this.triGroup = new Uint16Array(this.triCount);
    this.blocked = new Uint8Array(this.triCount);
    this.undoStack = [];
    this.redoStack = [];
    this._scrub = null;
    this.adjacency = buildAdjacency(mesh.geometry);
    this.triNormals = computeTriNormals(mesh.geometry);
    this.triCentroids = computeTriCentroids(mesh.geometry);
    this.repaintAll();
  }

  /**
   * Replace the mesh geometry with a refined triangle soup (from subdivision),
   * preserving group/blocker assignments per new triangle. Clears undo history
   * — geometry changes aren't undoable.
   */
  adoptRefined(positions, triGroup, blocked) {
    const geo = this.mesh.geometry;
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    newGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    newGeo.computeVertexNormals();
    newGeo.computeBoundingBox();
    newGeo.computeBoundsTree();
    geo.disposeBoundsTree();
    geo.dispose();
    this.mesh.geometry = newGeo;

    this.triCount = positions.length / 9;
    this.triGroup = triGroup;
    this.blocked = blocked;
    this.undoStack = [];
    this.redoStack = [];
    this._strokeChanges = null;
    this._scrub = null;
    this.adjacency = buildAdjacency(newGeo);
    this.triNormals = computeTriNormals(newGeo);
    this.triCentroids = computeTriCentroids(newGeo);
    this.repaintAll();
  }

  // ---- group management ----

  addGroup() {
    const i = this.groups.length;
    this.groups.push({
      name: `Color ${i + 1}`,
      color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    });
    this.activeGroup = i;
    return i;
  }

  removeGroup(index) {
    if (index === 0 || this.groups.length <= 1) return;
    for (let t = 0; t < this.triCount; t++) {
      if (this.triGroup[t] === index) this.triGroup[t] = 0;
      else if (this.triGroup[t] > index) this.triGroup[t]--;
    }
    this.groups.splice(index, 1);
    if (this.activeGroup >= this.groups.length) this.activeGroup = this.groups.length - 1;
    this.undoStack = [];
    this.redoStack = []; // ids shifted; old entries are invalid
    this.repaintAll();
  }

  // ---- color rendering ----

  repaintAll() {
    if (!this.mesh) return;
    for (let t = 0; t < this.triCount; t++) this._colorTri(t);
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  _colorTri(t) {
    const colAttr = this.mesh.geometry.attributes.color;
    const c = new THREE.Color(this.groups[this.triGroup[t]].color);
    if (this.blocked[t]) c.lerp(BLOCKER_TINT, 0.6);
    for (let v = 0; v < 3; v++) colAttr.setXYZ(t * 3 + v, c.r, c.g, c.b);
  }

  refreshGroupColor(index) {
    if (!this.mesh) return;
    for (let t = 0; t < this.triCount; t++) {
      if (this.triGroup[t] === index) this._colorTri(t);
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  // ---- stroke / undo ----

  beginStroke() {
    this._strokeChanges = { group: new Map(), blocked: new Map() };
  }

  endStroke() {
    const s = this._strokeChanges;
    this._strokeChanges = null;
    if (!s) return;
    // drop no-op entries (e.g. scrub expanded then retreated past them)
    for (const [t, prev] of s.group) if (this.triGroup[t] === prev) s.group.delete(t);
    for (const [t, prev] of s.blocked) if (this.blocked[t] === prev) s.blocked.delete(t);
    if (s.group.size || s.blocked.size) {
      this.undoStack.push(s);
      if (this.undoStack.length > 50) this.undoStack.shift();
      this.redoStack = []; // a fresh stroke invalidates the redo branch
    }
  }

  /** Revert the open stroke without recording it (used before subdivision
   *  re-applies the stroke precisely on refined geometry). */
  cancelStroke() {
    const s = this._strokeChanges;
    this._strokeChanges = null;
    if (!s) return;
    for (const [t, prev] of s.group) {
      this.triGroup[t] = prev;
      this._colorTri(t);
    }
    for (const [t, prev] of s.blocked) {
      this.blocked[t] = prev;
      this._colorTri(t);
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /**
   * Subdivide triangles that straddle the boundary of a stroke — a capsule
   * chain along `points` with the given radius — so brush/line edges come out
   * crisp on coarse meshes. Rebuilds the geometry (clears undo history).
   * The caller re-applies the paint afterwards (e.g. via paintPolyline).
   */
  async refineStroke(points, radius, { rounds = 3, onProgress } = {}) {
    if (!this.mesh || !points.length) return;
    const r2 = radius * radius;
    const inCapsule = (x, y, z) => {
      if (points.length === 1) {
        const dx = x - points[0].x, dy = y - points[0].y, dz = z - points[0].z;
        return dx * dx + dy * dy + dz * dz <= r2;
      }
      for (let s = 0; s < points.length - 1; s++) {
        if (distSqToSegment(x, y, z, points[s], points[s + 1]) <= r2) return true;
      }
      return false;
    };
    const classify = (x, y, z) => (inCapsule(x, y, z) ? 1 : -1);

    // cheap scope: capsule-chain AABB expanded by the radius
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    minX -= radius; minY -= radius; minZ -= radius;
    maxX += radius; maxY += radius; maxZ += radius;
    const inScope = (x, y, z) =>
      x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
    // triangle-AABB vs stroke-AABB overlap, so huge slivers the stroke only
    // crosses in the middle still get phase-1 size splitting
    const triInScope = (pos, o) => {
      let tminX = Infinity, tminY = Infinity, tminZ = Infinity;
      let tmaxX = -Infinity, tmaxY = -Infinity, tmaxZ = -Infinity;
      for (let k = 0; k < 3; k++) {
        const x = pos[o + k * 3], y = pos[o + k * 3 + 1], z = pos[o + k * 3 + 2];
        if (x < tminX) tminX = x; if (x > tmaxX) tmaxX = x;
        if (y < tminY) tminY = y; if (y > tmaxY) tmaxY = y;
        if (z < tminZ) tminZ = z; if (z > tmaxZ) tmaxZ = z;
      }
      return tmaxX >= minX && tminX <= maxX && tmaxY >= minY && tminY <= maxY &&
             tmaxZ >= minZ && tminZ <= maxZ;
    };

    const bb = this.mesh.geometry.boundingBox;
    const diag = bb.min.distanceTo(bb.max);
    const minEdgeVal = Math.max(0.15, diag * 0.003);
    const refined = await refineMesh(
      this.mesh.geometry.attributes.position.array,
      this.triGroup,
      this.blocked,
      classify,
      {
        maxRounds: rounds,
        minEdge: minEdgeVal,
        inScope,
        triInScope,
        maxEdge: Math.max(minEdgeVal * 2, radius),
        onProgress,
      }
    );
    this.adoptRefined(refined.positions, refined.triGroup, refined.blocked);
  }

  /** Swap the stored values of an undo/redo entry with the current state. */
  _applySwap(s) {
    for (const [t, v] of s.group) {
      const cur = this.triGroup[t];
      this.triGroup[t] = v;
      s.group.set(t, cur);
      this._colorTri(t);
    }
    for (const [t, v] of s.blocked) {
      const cur = this.blocked[t];
      this.blocked[t] = v;
      s.blocked.set(t, cur);
      this._colorTri(t);
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this._applySwap(s); // entry now holds the redo values
    this.redoStack.push(s);
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this._applySwap(s); // entry now holds the undo values again
    this.undoStack.push(s);
    return true;
  }

  _assign(t, group) {
    if (this.triGroup[t] === group) return;
    if (this._strokeChanges && !this._strokeChanges.group.has(t)) {
      this._strokeChanges.group.set(t, this.triGroup[t]);
    }
    this.triGroup[t] = group;
    this._colorTri(t);
  }

  _setBlocked(t, val) {
    if (this.blocked[t] === val) return;
    if (this._strokeChanges && !this._strokeChanges.blocked.has(t)) {
      this._strokeChanges.blocked.set(t, this.blocked[t]);
    }
    this.blocked[t] = val;
    this._colorTri(t);
  }

  // ---- painting tools ----

  /** Walk the surface from the hit triangle, applying `apply(t)` to all tris within radius. */
  _walkBrush(point, radius, seedTri, apply) {
    const r2 = radius * radius;
    const cen = this.triCentroids;
    const visited = new Set([seedTri]);
    const queue = [seedTri];
    while (queue.length) {
      const t = queue.pop();
      apply(t);
      for (let e = 0; e < 3; e++) {
        const n = this.adjacency[t * 3 + e];
        if (n < 0 || visited.has(n)) continue;
        visited.add(n);
        const dx = cen[n * 3] - point.x;
        const dy = cen[n * 3 + 1] - point.y;
        const dz = cen[n * 3 + 2] - point.z;
        if (dx * dx + dy * dy + dz * dz <= r2) queue.push(n);
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /** Apply to every triangle whose centroid is within radius, regardless of
   *  surface connectivity — reaches the hidden back side of thin walls. */
  _sphereBrush(point, radius, apply) {
    const r2 = radius * radius;
    const cen = this.triCentroids;
    for (let t = 0; t < this.triCount; t++) {
      const dx = cen[t * 3] - point.x;
      const dy = cen[t * 3 + 1] - point.y;
      const dz = cen[t * 3 + 2] - point.z;
      if (dx * dx + dy * dy + dz * dz <= r2) apply(t);
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /** Paint with the active group, or a specific group (0 = erase to base). */
  brush(point, radius, seedTri, through = false, group = this.activeGroup) {
    if (!this.mesh) return;
    const apply = (t) => this._assign(t, group);
    if (through) this._sphereBrush(point, radius, apply);
    else this._walkBrush(point, radius, seedTri, apply);
  }

  /**
   * Paint a polyline stripe: every triangle whose centroid lies within
   * width/2 of any segment (or of the single point) gets the active group,
   * or becomes a blocker when asBlocker is true. Caller manages the stroke.
   */
  paintPolyline(points, width, asBlocker = false) {
    if (!this.mesh || points.length === 0) return 0;
    const r2 = (width / 2) * (width / 2);
    const cen = this.triCentroids;
    const group = this.activeGroup;
    let count = 0;
    for (let t = 0; t < this.triCount; t++) {
      const px = cen[t * 3], py = cen[t * 3 + 1], pz = cen[t * 3 + 2];
      let hit = false;
      if (points.length === 1) {
        const dx = px - points[0].x, dy = py - points[0].y, dz = pz - points[0].z;
        hit = dx * dx + dy * dy + dz * dz <= r2;
      }
      for (let s = 0; s < points.length - 1 && !hit; s++) {
        hit = distSqToSegment(px, py, pz, points[s], points[s + 1]) <= r2;
      }
      if (hit) {
        if (asBlocker) this._setBlocked(t, 1);
        else this._assign(t, group);
        count++;
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
    return count;
  }

  /** Paint (or erase, when erase=true) fill blockers under the brush. */
  blockerBrush(point, radius, seedTri, erase, through = false) {
    if (!this.mesh) return;
    const apply = (t) => this._setBlocked(t, erase ? 0 : 1);
    if (through) this._sphereBrush(point, radius, apply);
    else this._walkBrush(point, radius, seedTri, apply);
  }

  clearBlockers() {
    if (!this.mesh) return;
    this.beginStroke();
    for (let t = 0; t < this.triCount; t++) this._setBlocked(t, 0);
    this.endStroke();
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /** Crossing cost between adjacent triangles: dihedral angle in degrees,
   *  multiplied when the edge is a valley (concave). */
  _edgeCost(t, n) {
    const N = this.triNormals, C = this.triCentroids;
    const dot = N[t * 3] * N[n * 3] + N[t * 3 + 1] * N[n * 3 + 1] + N[t * 3 + 2] * N[n * 3 + 2];
    const angle = Math.acos(Math.min(1, Math.max(-1, dot))) * (180 / Math.PI);
    // neighbor centroid above this triangle's plane => bending toward us => valley
    const dx = C[n * 3] - C[t * 3], dy = C[n * 3 + 1] - C[t * 3 + 1], dz = C[n * 3 + 2] - C[t * 3 + 2];
    const side = N[t * 3] * dx + N[t * 3 + 1] * dy + N[t * 3 + 2] * dz;
    return side > 1e-6 ? angle * CONCAVE_COST_MULT : angle;
  }

  /**
   * Priority flood from a seed: triangles ordered by the cheapest worst-edge
   * (bottleneck) path from the seed, never crossing blockers. The result can
   * be scrubbed to any cost threshold with scrubTo().
   */
  startScrubFill(seedTri) {
    if (!this.mesh || this.blocked[seedTri]) return false;
    const N = this.triCount;
    const entry = new Float32Array(N).fill(Infinity);
    const done = new Uint8Array(N);
    const heap = new MinHeap(N);
    entry[seedTri] = 0;
    heap.push(0, seedTri);
    const order = [];
    const costs = [];
    while (heap.size) {
      const [c, t] = heap.pop();
      if (done[t]) continue;
      done[t] = 1;
      order.push(t);
      costs.push(c);
      for (let e = 0; e < 3; e++) {
        const n = this.adjacency[t * 3 + e];
        if (n < 0 || done[n] || this.blocked[n]) continue;
        const ec = Math.max(c, this._edgeCost(t, n));
        if (ec < entry[n]) {
          entry[n] = ec;
          heap.push(ec, n);
        }
      }
    }
    this._scrub = { order, costs, pos: 0, group: this.activeGroup };
    return true;
  }

  /** Expand/retreat the active scrub fill to the given cost threshold (degrees). */
  scrubTo(limit) {
    const s = this._scrub;
    if (!s) return 0;
    while (s.pos < s.order.length && s.costs[s.pos] <= limit) {
      this._assign(s.order[s.pos], s.group);
      s.pos++;
    }
    while (s.pos > 0 && s.costs[s.pos - 1] > limit) {
      s.pos--;
      const t = s.order[s.pos];
      const prev = this._strokeChanges ? this._strokeChanges.group.get(t) : undefined;
      if (prev !== undefined) {
        this.triGroup[t] = prev;
        this._colorTri(t);
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
    return s.pos;
  }

  endScrubFill() {
    this._scrub = null;
  }

  /** Fill every triangle connected to the seed, stopping at blockers. */
  islandFill(seedTri) {
    if (!this.mesh || this.blocked[seedTri]) return;
    const group = this.activeGroup;
    const visited = new Uint8Array(this.triCount);
    visited[seedTri] = 1;
    const queue = [seedTri];
    while (queue.length) {
      const t = queue.pop();
      this._assign(t, group);
      for (let e = 0; e < 3; e++) {
        const n = this.adjacency[t * 3 + e];
        if (n >= 0 && !visited[n] && !this.blocked[n]) {
          visited[n] = 1;
          queue.push(n);
        }
      }
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  /** Expand the active group's region by one triangle ring (blockers excluded). */
  grow() {
    if (!this.mesh) return 0;
    const g = this.activeGroup;
    const toAdd = [];
    for (let t = 0; t < this.triCount; t++) {
      if (this.triGroup[t] !== g) continue;
      for (let e = 0; e < 3; e++) {
        const n = this.adjacency[t * 3 + e];
        if (n >= 0 && this.triGroup[n] !== g && !this.blocked[n]) toAdd.push(n);
      }
    }
    for (const t of toAdd) this._assign(t, g);
    this.mesh.geometry.attributes.color.needsUpdate = true;
    return toAdd.length;
  }

  /**
   * Remove paint specks: connected same-group islands smaller than `minSize`
   * triangles are absorbed into the group they share the most border with.
   * This kills hidden leftovers after painting over a region (residue on
   * backsides and in crevices that a stroke couldn't reach).
   */
  despeckle(minSize) {
    if (!this.mesh) return { islands: 0, tris: 0 };
    const N = this.triCount;
    const comp = new Int32Array(N).fill(-1);
    const members = [];
    let compCount = 0;
    const stack = [];
    for (let t0 = 0; t0 < N; t0++) {
      if (comp[t0] >= 0) continue;
      const id = compCount++;
      const list = [];
      comp[t0] = id;
      stack.length = 0;
      stack.push(t0);
      while (stack.length) {
        const t = stack.pop();
        list.push(t);
        for (let e = 0; e < 3; e++) {
          const n = this.adjacency[t * 3 + e];
          if (n >= 0 && comp[n] < 0 && this.triGroup[n] === this.triGroup[t]) {
            comp[n] = id;
            stack.push(n);
          }
        }
      }
      members.push(list);
    }

    let islands = 0, tris = 0;
    for (const list of members) {
      if (list.length >= minSize) continue;
      const own = this.triGroup[list[0]];
      const counts = new Map();
      for (const t of list) {
        for (let e = 0; e < 3; e++) {
          const n = this.adjacency[t * 3 + e];
          if (n >= 0 && this.triGroup[n] !== own) {
            counts.set(this.triGroup[n], (counts.get(this.triGroup[n]) || 0) + 1);
          }
        }
      }
      if (!counts.size) continue; // isolated shell entirely one color — keep it
      let best = own, bestCount = -1;
      for (const [g, c] of counts) if (c > bestCount) { best = g; bestCount = c; }
      for (const t of list) this._assign(t, best);
      islands++;
      tris += list.length;
    }
    this.mesh.geometry.attributes.color.needsUpdate = true;
    return { islands, tris };
  }

  /** Contract the active group's region by one ring; freed triangles take the
   *  most common neighboring group. */
  shrink() {
    if (!this.mesh) return 0;
    const g = this.activeGroup;
    const toFree = []; // [tri, replacementGroup]
    for (let t = 0; t < this.triCount; t++) {
      if (this.triGroup[t] !== g) continue;
      const counts = new Map();
      let boundary = false;
      for (let e = 0; e < 3; e++) {
        const n = this.adjacency[t * 3 + e];
        if (n < 0) { boundary = true; continue; }
        const ng = this.triGroup[n];
        if (ng !== g) {
          boundary = true;
          counts.set(ng, (counts.get(ng) || 0) + 1);
        }
      }
      if (!boundary) continue;
      let best = 0, bestCount = -1;
      for (const [grp, cnt] of counts) if (cnt > bestCount) { best = grp; bestCount = cnt; }
      toFree.push([t, best]);
    }
    for (const [t, grp] of toFree) this._assign(t, grp);
    this.mesh.geometry.attributes.color.needsUpdate = true;
    return toFree.length;
  }

  /** Triangle counts per group, e.g. to warn about empty groups on export. */
  groupStats() {
    const counts = new Array(this.groups.length).fill(0);
    for (let t = 0; t < this.triCount; t++) counts[this.triGroup[t]]++;
    return counts;
  }
}

/** Binary min-heap of (cost, id) pairs. */
class MinHeap {
  constructor(capacity = 64) {
    this.costs = new Float32Array(capacity);
    this.ids = new Uint32Array(capacity);
    this.size = 0;
  }
  push(cost, id) {
    if (this.size === this.costs.length) {
      const c = new Float32Array(this.size * 2); c.set(this.costs); this.costs = c;
      const i = new Uint32Array(this.size * 2); i.set(this.ids); this.ids = i;
    }
    let k = this.size++;
    this.costs[k] = cost;
    this.ids[k] = id;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.costs[p] <= this.costs[k]) break;
      this._swap(k, p);
      k = p;
    }
  }
  pop() {
    const top = [this.costs[0], this.ids[0]];
    this.size--;
    if (this.size > 0) {
      this.costs[0] = this.costs[this.size];
      this.ids[0] = this.ids[this.size];
      let k = 0;
      for (;;) {
        const l = k * 2 + 1, r = l + 1;
        let m = k;
        if (l < this.size && this.costs[l] < this.costs[m]) m = l;
        if (r < this.size && this.costs[r] < this.costs[m]) m = r;
        if (m === k) break;
        this._swap(k, m);
        k = m;
      }
    }
    return top;
  }
  _swap(a, b) {
    const c = this.costs[a]; this.costs[a] = this.costs[b]; this.costs[b] = c;
    const i = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = i;
  }
}

/**
 * Build triangle adjacency for non-indexed geometry by welding vertices on
 * exact coordinates (STL repeats identical floats for shared vertices).
 * Returns Int32Array of 3 neighbors per triangle, -1 where no neighbor.
 */
function buildAdjacency(geometry) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  const adjacency = new Int32Array(triCount * 3).fill(-1);

  const vertId = new Int32Array(pos.count);
  const seen = new Map();
  let nextId = 0;
  for (let i = 0; i < pos.count; i++) {
    const key = pos.getX(i) + '_' + pos.getY(i) + '_' + pos.getZ(i);
    let id = seen.get(key);
    if (id === undefined) {
      id = nextId++;
      seen.set(key, id);
    }
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

function computeTriNormals(geometry) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  const normals = new Float32Array(triCount * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    a.fromBufferAttribute(pos, t * 3);
    b.fromBufferAttribute(pos, t * 3 + 1);
    c.fromBufferAttribute(pos, t * 3 + 2);
    b.sub(a);
    c.sub(a);
    b.cross(c).normalize();
    normals[t * 3] = b.x;
    normals[t * 3 + 1] = b.y;
    normals[t * 3 + 2] = b.z;
  }
  return normals;
}

/** Squared distance from point (px,py,pz) to segment a-b. */
function distSqToSegment(px, py, pz, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = px - a.x, apy = py - a.y, apz = pz - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let s = len2 > 0 ? (apx * abx + apy * aby + apz * abz) / len2 : 0;
  s = Math.max(0, Math.min(1, s));
  const dx = apx - s * abx, dy = apy - s * aby, dz = apz - s * abz;
  return dx * dx + dy * dy + dz * dz;
}

function computeTriCentroids(geometry) {
  const pos = geometry.attributes.position;
  const triCount = pos.count / 3;
  const cen = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let axis = 0; axis < 3; axis++) {
      cen[t * 3 + axis] = (
        pos.array[(t * 3) * 3 + axis] +
        pos.array[(t * 3 + 1) * 3 + axis] +
        pos.array[(t * 3 + 2) * 3 + axis]
      ) / 3;
    }
  }
  return cen;
}
