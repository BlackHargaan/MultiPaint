import { buildMeshCachesFromPositions } from './meshcore.js';

// Build per-triangle caches off the main thread. Receives a transferred
// position copy, returns the caches with their buffers transferred back.
self.onmessage = (e) => {
  const { id, positions } = e.data;
  const c = buildMeshCachesFromPositions(positions);
  self.postMessage(
    { id, triCount: c.triCount, adjacency: c.adjacency, triNormals: c.triNormals, triCentroids: c.triCentroids },
    [c.adjacency.buffer, c.triNormals.buffer, c.triCentroids.buffer]
  );
};
