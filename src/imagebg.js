/**
 * Background removal for decal images: flood-fills from the image borders,
 * removing pixels similar to the corner colors, so only the subject remains.
 * Non-destructive — always run on the original image.
 *
 * @param source ImageBitmap / canvas / img
 * @param tolerance max RGB distance to count as background (per flood step)
 * @param edge     >0 grows the removed area by N px (trims halo fringes),
 *                 <0 shrinks it (keeps more of the subject's edge)
 * @returns canvas with background pixels set fully transparent
 */
export function removeBackground(source, { tolerance = 40, edge = 0 } = {}) {
  const w = source.width, h = source.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  // background references: the four corner colors
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4]
    .map((i) => [d[i], d[i + 1], d[i + 2]]);
  const tolSq = tolerance * tolerance * 3;
  const isBg = (i) => {
    if (d[i + 3] < 20) return true; // already transparent
    for (const c of corners) {
      const dr = d[i] - c[0], dg = d[i + 1] - c[1], db = d[i + 2] - c[2];
      if (dr * dr + dg * dg + db * db <= tolSq) return true;
    }
    return false;
  };

  // flood fill from every border pixel that matches a corner color
  let mask = new Uint8Array(w * h); // 1 = background
  const queue = [];
  const seed = (x, y) => {
    const p = y * w + x;
    if (!mask[p] && isBg(p * 4)) {
      mask[p] = 1;
      queue.push(p);
    }
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (queue.length) {
    const p = queue.pop();
    const x = p % w, y = (p / w) | 0;
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }

  // grow / shrink the removed area (4-neighborhood dilate / erode)
  for (let step = 0; step < Math.abs(edge); step++) {
    const grow = edge > 0;
    const next = new Uint8Array(mask);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const neighborHas = (v) =>
          (x > 0 && mask[p - 1] === v) || (x < w - 1 && mask[p + 1] === v) ||
          (y > 0 && mask[p - w] === v) || (y < h - 1 && mask[p + w] === v);
        if (grow && !mask[p] && neighborHas(1)) next[p] = 1;
        if (!grow && mask[p] && neighborHas(0)) next[p] = 0;
      }
    }
    mask = next;
  }

  let removed = 0;
  for (let p = 0; p < mask.length; p++) {
    if (mask[p]) {
      d[p * 4 + 3] = 0;
      removed++;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, removedFraction: removed / mask.length };
}
