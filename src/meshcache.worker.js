import { buildMeshCachesFromPositions, orientShells } from './meshcore.js';

// Mesh work off the main thread. Receives a transferred position copy and
// returns results with their buffers transferred back:
//   kind 'caches' → per-triangle caches (adjacency, normals, centroids)
//   kind 'orient' → the winding-repaired positions + stats
self.onmessage = (e) => {
  const { id, kind, positions } = e.data;
  if (kind === 'orient') {
    const stats = orientShells(positions);
    self.postMessage({ id, positions, stats }, [positions.buffer]);
    return;
  }
  const c = buildMeshCachesFromPositions(positions);
  self.postMessage(
    { id, triCount: c.triCount, adjacency: c.adjacency, triNormals: c.triNormals, triCentroids: c.triCentroids },
    [c.adjacency.buffer, c.triNormals.buffer, c.triCentroids.buffer]
  );
};
