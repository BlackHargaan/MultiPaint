import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export class Viewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1d21);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
    this.camera.position.set(80, -80, 60);
    this.camera.up.set(0, 0, 1); // printer convention: Z up

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = {
      LEFT: null, // left button reserved for painting
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };

    const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1.2);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(1, -1, 2);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-1, 1, -0.5);
    this.scene.add(dir2);

    const grid = new THREE.GridHelper(200, 20, 0x3a3f46, 0x2a2e34);
    grid.rotation.x = Math.PI / 2; // lie flat in XY plane (Z up)
    this.scene.add(grid);

    this.mesh = null;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.pointer = new THREE.Vector2();

    // brush circle that hugs the surface
    this.brushCursor = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, side: THREE.DoubleSide,
        depthTest: false, transparent: true, opacity: 0.9,
      })
    );
    this.brushCursor.renderOrder = 999;
    this.brushCursor.visible = false;
    this.scene.add(this.brushCursor);

    // polyline tool preview (capsule chain)
    this.lineGroup = new THREE.Group();
    this.lineGroup.renderOrder = 998;
    this.scene.add(this.lineGroup);

    window.addEventListener('resize', () => this.resize());
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (this.camera.isPerspectiveCamera) {
      this.camera.aspect = w / h;
    } else {
      const halfH = this._orthoHalfH || 50;
      const halfW = halfH * (w / h);
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.top = halfH;
      this.camera.bottom = -halfH;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _modelCenterAndSize() {
    if (this.mesh) {
      const bb = this.mesh.geometry.boundingBox;
      const center = new THREE.Vector3();
      bb.getCenter(center);
      const size = new THREE.Vector3();
      bb.getSize(size);
      return { center, radius: Math.max(size.x, size.y, size.z) };
    }
    return { center: new THREE.Vector3(0, 0, 20), radius: 60 };
  }

  /** Swap between perspective and orthographic projection, keeping the view. */
  setOrtho(on) {
    if (on === !this.camera.isPerspectiveCamera) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const pos = this.camera.position.clone();
    const target = this.controls.target.clone();
    const dist = pos.distanceTo(target);
    let cam;
    if (on) {
      // match the perspective framing at the target distance
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      this._orthoHalfH = halfH;
      const halfW = halfH * (w / h);
      cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, -5000, 5000);
    } else {
      cam = new THREE.PerspectiveCamera(50, w / h, 0.1, 5000);
    }
    cam.up.copy(this.camera.up);
    cam.position.copy(pos);
    const mouseButtons = this.controls.mouseButtons;
    this.controls.dispose();
    this.camera = cam;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.controls = new OrbitControls(cam, this.renderer.domElement);
    this.controls.mouseButtons = mouseButtons;
    this.controls.target.copy(target);
    cam.lookAt(target);
    this.controls.update();
  }

  /** Jump to an axis-aligned preset view: front/back/left/right/top/bottom. */
  setView(name) {
    const { center, radius } = this._modelCenterAndSize();
    const d = radius * 2.2;
    const iso = 1 / Math.hypot(1, 1, 0.8);
    const dirs = {
      front: [0, -1, 0], back: [0, 1, 0],
      left: [-1, 0, 0], right: [1, 0, 0],
      top: [0, 0, 1], bottom: [0, 0, -1],
      home: [iso, -iso, 0.8 * iso], // the three-quarter view used on load
    };
    const dir = dirs[name];
    if (!dir) return;
    this.camera.up.set(0, 0, 1);
    if (name === 'top') this.camera.up.set(0, 1, 0);
    if (name === 'bottom') this.camera.up.set(0, -1, 0);
    this.camera.position.set(
      center.x + dir[0] * d,
      center.y + dir[1] * d,
      center.z + dir[2] * d
    );
    this.controls.target.copy(center);
    if (!this.camera.isPerspectiveCamera) {
      const w = this.container.clientWidth || 1;
      const h = this.container.clientHeight || 1;
      this._orthoHalfH = radius * 0.7;
      const halfW = this._orthoHalfH * (w / h);
      this.camera.left = -halfW;
      this.camera.right = halfW;
      this.camera.top = this._orthoHalfH;
      this.camera.bottom = -this._orthoHalfH;
      this.camera.zoom = 1;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  /** Capture the full camera pose (for snapshot restore). */
  getViewState() {
    return {
      ortho: !this.camera.isPerspectiveCamera,
      position: this.camera.position.clone(),
      up: this.camera.up.clone(),
      target: this.controls.target.clone(),
      zoom: this.camera.zoom,
      orthoHalfH: this._orthoHalfH,
    };
  }

  /** Restore a pose captured with getViewState(). */
  applyViewState(s) {
    if (!s) return;
    this.setOrtho(s.ortho);
    this.camera.up.copy(s.up);
    this.camera.position.copy(s.position);
    this.controls.target.copy(s.target);
    if (s.ortho) {
      this._orthoHalfH = s.orthoHalfH;
      this.resize();
    }
    this.camera.zoom = s.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Build the scene mesh from a cleaned, non-indexed triangle soup. */
  loadPositions(positions) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.disposeBoundsTree();
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return this._setupMesh(geometry);
  }

  loadSTL(arrayBuffer) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.disposeBoundsTree();
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }

    let geometry = new STLLoader().parse(arrayBuffer);
    geometry = geometry.toNonIndexed ? (geometry.index ? geometry.toNonIndexed() : geometry) : geometry;

    // Drop degenerate triangles (zero-area slivers with two identical
    // corners). Many STLs contain them (Benchy has 552); slicers silently
    // remove them on STL import, but written into an indexed 3MF they become
    // non-manifold edges.
    {
      const src = geometry.attributes.position.array;
      const triCount = src.length / 9;
      const eq = (i, j) => src[i] === src[j] && src[i + 1] === src[j + 1] && src[i + 2] === src[j + 2];
      let kept = 0;
      const keep = new Uint8Array(triCount);
      for (let t = 0; t < triCount; t++) {
        const o = t * 9;
        if (!(eq(o, o + 3) || eq(o + 3, o + 6) || eq(o, o + 6))) {
          keep[t] = 1;
          kept++;
        }
      }
      if (kept < triCount) {
        const clean = new Float32Array(kept * 9);
        let w = 0;
        for (let t = 0; t < triCount; t++) {
          if (keep[t]) {
            clean.set(src.subarray(t * 9, t * 9 + 9), w);
            w += 9;
          }
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(clean, 3));
        console.info(`Dropped ${triCount - kept} degenerate triangle(s) from the STL.`);
      }
    }
    return this._setupMesh(geometry);
  }

  /** Shared mesh setup: normals, centering, colors, BVH, material, framing. */
  _setupMesh(geometry) {
    geometry.computeVertexNormals();

    // center on the plate, rest on Z=0
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const cx = (bb.min.x + bb.max.x) / 2;
    const cy = (bb.min.y + bb.max.y) / 2;
    geometry.translate(-cx, -cy, -bb.min.z);
    geometry.computeBoundingBox();

    // per-vertex colors, driven by the painter
    const count = geometry.attributes.position.count;
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));

    geometry.computeBoundsTree();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.55,
      metalness: 0.0,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);

    // frame the model
    const size = new THREE.Vector3();
    geometry.boundingBox.getSize(size);
    const d = Math.max(size.x, size.y, size.z) * 1.8;
    this.controls.target.set(0, 0, size.z / 2);
    this.camera.position.set(d, -d, d * 0.8);

    return this.mesh;
  }

  /** Raycast the mouse event against the model. Returns intersection or null. */
  pick(event) {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.camera.updateMatrixWorld(); // pick may run before the first frame after a load
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.mesh, false);
    if (!hits.length) return null;
    const hit = hits[0];
    // computeBoundsTree() adds an index and sorts it, so raycast faceIndex is
    // in BVH order; map back to original attribute-order triangle id
    const index = this.mesh.geometry.index;
    if (index && hit.faceIndex !== undefined) {
      hit.faceIndex = index.getX(hit.faceIndex * 3) / 3;
    }
    return hit;
  }

  /** Show the polyline tool's points and segments at true stripe width. */
  setPolylinePreview(points, width, colorHex) {
    this.clearPolylinePreview();
    if (!points.length) return;
    const r = width / 2;
    const mat = new THREE.MeshBasicMaterial({
      color: colorHex, transparent: true, opacity: 0.55, depthTest: false,
    });
    const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < points.length; i++) {
      const dot = new THREE.Mesh(sphereGeo, mat);
      dot.position.copy(points[i]);
      dot.scale.setScalar(r);
      this.lineGroup.add(dot);
      if (i === 0) continue;
      const a = points[i - 1], b = points[i];
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1e-6) continue;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), mat);
      cyl.position.copy(a).addScaledVector(dir, 0.5);
      cyl.quaternion.setFromUnitVectors(up, dir.normalize());
      this.lineGroup.add(cyl);
    }
  }

  clearPolylinePreview() {
    for (const child of [...this.lineGroup.children]) {
      this.lineGroup.remove(child);
      child.geometry.dispose();
    }
  }

  updateBrushCursor(hit, radius, color = 0xffffff) {
    if (!hit) {
      this.brushCursor.visible = false;
      return;
    }
    this.brushCursor.visible = true;
    this.brushCursor.material.color.setHex(color);
    this.brushCursor.scale.setScalar(radius);
    this.brushCursor.position.copy(hit.point);
    if (hit.face) {
      const normal = hit.face.normal.clone();
      this.brushCursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      this.brushCursor.position.addScaledVector(normal, 0.05);
    }
  }
}
