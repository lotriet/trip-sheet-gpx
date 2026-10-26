/**
 * Image clean-up for trip sheet photos, on plain grayscale buffers so it runs
 * the same in the browser (canvas) and in Node tests.
 *
 * Phone photos show the sheet on a car seat, a desk or a jacket. Fed whole,
 * the OCR engine reads the background texture as rows of junk letters, and a
 * sideways photo comes out as pure gibberish. So: find the white page, crop to
 * it, turn it upright, scale it so the print is a readable size, and flatten
 * shadows before the OCR engine sees it.
 */

export type Gray = { data: Uint8Array; width: number; height: number };
export type Box = { x: number; y: number; w: number; h: number };

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < data.length; i += 4, j++) {
    data[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return { data, width, height };
}

/** Area-average downscale (or bilinear upscale) to the given size. */
export function resize(src: Gray, width: number, height: number): Gray {
  const out = new Uint8Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * src.width;
          for (let xx = x0; xx < x1; xx++) sum += src.data[row + xx];
        }
        out[y * width + x] = sum / ((y1 - y0) * (x1 - x0));
      }
    }
    return { data: out, width, height };
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = src.data[y0 * src.width + x0] * (1 - wx) + src.data[y0 * src.width + x1] * wx;
      const b = src.data[y1 * src.width + x0] * (1 - wx) + src.data[y1 * src.width + x1] * wx;
      out[y * width + x] = a * (1 - wy) + b * wy;
    }
  }
  return { data: out, width, height };
}

export function crop(src: Gray, box: Box): Gray {
  const out = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const s = (box.y + y) * src.width + box.x;
    out.set(src.data.subarray(s, s + box.w), y * box.w);
  }
  return { data: out, width: box.w, height: box.h };
}

/** Rotate clockwise by 0, 90, 180 or 270 degrees. */
export function rotate(src: Gray, degrees: number): Gray {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) return src;
  const { width: w, height: h, data } = src;
  if (d === 180) {
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[data.length - 1 - i];
    return { data: out, width: w, height: h };
  }
  const out = new Uint8Array(data.length);
  // New image is h wide and w tall.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (d === 90) out[x * h + (h - 1 - y)] = v;
      else out[(w - 1 - x) * h + y] = v;
    }
  }
  return { data: out, width: h, height: w };
}

function otsu(data: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = data.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Find the sheet of paper: the largest bright region. Returns a box in the
 * coordinates of `src`, or null when the page fills the photo (or none is found).
 */
export type Page = { box: Box; outside: Uint8Array; sw: number; sh: number; scale: number; contrast: number };

export function findPage(src: Gray): Page | null {
  const long = 320;
  const scale = Math.min(1, long / Math.max(src.width, src.height));
  const sw = Math.max(1, Math.round(src.width * scale));
  const sh = Math.max(1, Math.round(src.height * scale));
  const small = resize(src, sw, sh);
  // Smooth out the printed text so the page reads as one bright block.
  const blurred = boxBlur(small, 2);
  const t = otsu(blurred.data);
  const mask = new Uint8Array(sw * sh);
  for (let i = 0; i < mask.length; i++) mask[i] = blurred.data[i] > t ? 1 : 0;

  // Largest 4-connected bright component.
  const label = new Int32Array(sw * sh);
  const stack = new Int32Array(sw * sh);
  let bestArea = 0;
  let bestBox: Box | null = null;
  let bestLabel = 0;
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    let area = 0;
    let minX = sw, minY = sh, maxX = 0, maxY = 0;
    while (top) {
      const p = stack[--top];
      area++;
      const x = p % sw;
      const y = (p - x) / sw;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = next; stack[top++] = p - 1; }
      if (x < sw - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = next; stack[top++] = p + 1; }
      if (y > 0 && mask[p - sw] && !label[p - sw]) { label[p - sw] = next; stack[top++] = p - sw; }
      if (y < sh - 1 && mask[p + sw] && !label[p + sw]) { label[p + sw] = next; stack[top++] = p + sw; }
    }
    if (area > bestArea) {
      bestArea = area;
      bestLabel = next;
      bestBox = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
  }
  if (!bestBox) return null;
  const boxArea = bestBox.w * bestBox.h;
  // Too small to be the page.
  if (bestArea < 0.12 * sw * sh || boxArea < 0.12 * sw * sh) return null;
  const pad = Math.round(0.01 * Math.max(sw, sh));
  const x0 = Math.max(0, bestBox.x - pad);
  const y0 = Math.max(0, bestBox.y - pad);
  const x1 = Math.min(sw, bestBox.x + bestBox.w + pad);
  const y1 = Math.min(sh, bestBox.y + bestBox.h + pad);
  const inv = 1 / scale;
  const x = Math.floor(x0 * inv);
  const y = Math.floor(y0 * inv);

  // Background = everything reachable from the photo edge without crossing the
  // page. Holes inside the page (text, highlighter) stay part of the page.
  const outside = new Uint8Array(sw * sh);
  let top = 0;
  const push = (p: number) => {
    if (!outside[p] && label[p] !== bestLabel) { outside[p] = 1; stack[top++] = p; }
  };
  for (let i = 0; i < sw; i++) { push(i); push((sh - 1) * sw + i); }
  for (let i = 0; i < sh; i++) { push(i * sw); push(i * sw + sw - 1); }
  while (top) {
    const p = stack[--top];
    const px = p % sw;
    if (px > 0) push(p - 1);
    if (px < sw - 1) push(p + 1);
    if (p >= sw) push(p - sw);
    if (p < sw * (sh - 1)) push(p + sw);
  }
  // Grow the background one cell so the page's shadowed edge is blanked too.
  const grown = outside.slice();
  for (let p = 0; p < outside.length; p++) {
    if (!outside[p]) continue;
    const px = p % sw;
    if (px > 0) grown[p - 1] = 1;
    if (px < sw - 1) grown[p + 1] = 1;
    if (p >= sw) grown[p - sw] = 1;
    if (p < sw * (sh - 1)) grown[p + sw] = 1;
  }
  // How much brighter the page is than what's around it. White paper on a
  // seat or desk stands out by 50+ levels; a patch of fabric does not.
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (let p = 0; p < grown.length; p++) {
    if (label[p] === bestLabel) { inSum += blurred.data[p]; inN++; }
    else if (grown[p]) { outSum += blurred.data[p]; outN++; }
  }
  const contrast = outN > 0.02 * grown.length ? inSum / inN - outSum / outN : 255;
  return {
    contrast,
    box: {
      x,
      y,
      w: Math.min(src.width - x, Math.ceil((x1 - x0) * inv)),
      h: Math.min(src.height - y, Math.ceil((y1 - y0) * inv)),
    },
    outside: grown,
    sw,
    sh,
    scale,
  };
}

/** Paint everything that is not the page white, so background texture can't be read as text. */
function blankOutside(src: Gray, page: Page): Gray {
  const out = new Uint8Array(src.data);
  const { box, outside, sw, scale } = page;
  for (let y = 0; y < box.h; y++) {
    const sy = Math.min(page.sh - 1, Math.floor((box.y + y) * scale));
    for (let x = 0; x < box.w; x++) {
      const sx = Math.min(sw - 1, Math.floor((box.x + x) * scale));
      if (outside[sy * sw + sx]) out[(box.y + y) * src.width + box.x + x] = 255;
    }
  }
  return { data: out, width: src.width, height: src.height };
}

function boxBlur(src: Gray, r: number): Gray {
  const { width: w, height: h } = src;
  const tmp = new Float32Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w) { s += src.data[y * w + xx]; n++; }
      }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; }
      }
      out[y * w + x] = s / n;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Even out shadows and uneven light: divide by a local estimate of the paper
 * brightness (a coarse max filter), then stretch so ink is dark and paper white.
 */
export function flattenLight(src: Gray): Gray {
  const { width: w, height: h, data } = src;
  const cell = Math.max(8, Math.round(Math.max(w, h) / 60));
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const grid = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      // 90th percentile of the cell ≈ paper brightness, ignoring the ink.
      const hist = new Uint32Array(256);
      let n = 0;
      for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y += 2) {
        for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x += 2) { hist[data[y * w + x]]++; n++; }
      }
      let acc = 0, v = 255;
      for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.1) { v = i; break; } }
      grid[cy * cw + cx] = Math.max(v, 1);
    }
  }
  // Smooth the grid (3x3 max then mean) so text-heavy cells don't dip.
  const g2 = new Float32Array(grid.length);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = cy + dy, xx = cx + dx;
        if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) m = Math.max(m, grid[yy * cw + xx]);
      }
      g2[cy * cw + cx] = m;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(ch - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(gy), y1 = Math.min(ch - 1, y0 + 1), wy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(gx), x1 = Math.min(cw - 1, x0 + 1), wx = gx - x0;
      const bg =
        (g2[y0 * cw + x0] * (1 - wx) + g2[y0 * cw + x1] * wx) * (1 - wy) +
        (g2[y1 * cw + x0] * (1 - wx) + g2[y1 * cw + x1] * wx) * wy;
      const v = (data[y * w + x] / bg) * 255;
      out[y * w + x] = v >= 255 ? 255 : v;
    }
  }
  // Contrast stretch: 1st percentile → black, paper → white.
  const hist = new Uint32Array(256);
  for (let i = 0; i < out.length; i += 3) hist[out[i]]++;
  const total = Math.ceil(out.length / 3);
  let acc = 0, lo = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.01) { lo = i; break; } }
  const hi = 235;
  const span = Math.max(30, hi - lo);
  for (let i = 0; i < out.length; i++) {
    const v = ((out[i] - lo) / span) * 255;
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return { data: out, width: w, height: h };
}

/** Target width of the cleaned page. A letter page at ~2000 px puts body text near 30 px tall. */
export const PAGE_WIDTH = 2000;

/** Never hand the OCR engine more than this on the long side; huge images are slow. */
export const MAX_PAGE_SIDE = 3400;

/** Below this, the "page" is probably not a sheet of paper (see findPage). */
export const MIN_PAGE_CONTRAST = 55;

export type Prepared = { image: Gray; landscape: boolean; cropped: boolean; convincing: boolean };

/** Crop to the page, scale it, flatten the light. Rotation is decided later. */
export function preparePage(src: Gray): Prepared {
  const found = findPage(src);
  // A weak page mask can classify shadows on the paper as background and
  // erase whole rows. Use the original photo when the detection is uncertain.
  const foundRatio = found ? Math.max(found.box.w, found.box.h) / Math.min(found.box.w, found.box.h) : Infinity;
  const convincing = !!found && found.contrast >= MIN_PAGE_CONTRAST && foundRatio < 1.9;
  const safeCrop = !!found && found.box.w * found.box.h >= src.width * src.height * 0.9;
  let page = convincing && found
    ? crop(blankOutside(src, found), found.box)
    : safeCrop && found
      ? crop(src, found.box)
      : src;
  const landscape = page.width > page.height * 1.08;
  // Scale so the page's short side (its width when upright) is PAGE_WIDTH.
  const short = Math.min(page.width, page.height);
  const s = Math.min(PAGE_WIDTH / short, MAX_PAGE_SIDE / Math.max(page.width, page.height));
  page = resize(page, Math.max(1, Math.round(page.width * s)), Math.max(1, Math.round(page.height * s)));
  return { image: flattenLight(page), landscape, cropped: convincing || safeCrop, convincing };
}

/**
 * The whole photo, scaled and flattened, with no page crop. Used when the
 * cropped page lost part of the sheet: a fold or shadow across the paper can
 * look like background to `findPage`.
 */
export function prepareWholePhoto(src: Gray): Prepared {
  const landscape = src.width > src.height * 1.08;
  const short = Math.min(src.width, src.height);
  const s = Math.min(PAGE_WIDTH / short, MAX_PAGE_SIDE / Math.max(src.width, src.height));
  const page = resize(src, Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  return { image: flattenLight(page), landscape, cropped: false, convincing: false };
}

/** Rotations to try, most likely first. */
export function rotationCandidates(landscape: boolean): number[] {
  return landscape ? [90, 270] : [0, 180];
}
