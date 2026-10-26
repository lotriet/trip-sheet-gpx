/**
 * Read photos of trip sheets in the browser. Photos are never uploaded.
 *
 * Steps per photo: decode it (HEIC included) upright, find the white page and
 * blank the background around it, scale the page so the print is ~30 px tall,
 * flatten the light, then OCR. A sideways or upside-down page is retried in the
 * other direction. Text that doesn't look like a trip sheet is refused rather
 * than passed on as gibberish.
 */

import { crop, preparePage, prepareWholePhoto, resize, rgbaToGray, rotate, rotationCandidates, type Gray, type Prepared } from "./ocr/prep";
import { mergeLoadColumn, normalizeSheetOcr } from "./ocr/document";
import { judgeSheetText, RETAKE_MESSAGE } from "./ocr/quality";
import type { ImageLike, PSM as PageSegmentationMode } from "tesseract.js";

export type PhotoResult =
  | {
      ok: true;
      name: string;
      text: string;
      /** Small JPEG of the page as read, for telling pages apart. */
      thumb?: string;
      /** The page footer was never read, so the bottom of the page may be missing. */
      incomplete?: boolean;
      /** The load column has this many more rows than stop lines were read. */
      missingStops?: number;
    }
  | { ok: false; name: string; reason: string };

type NativeOcrLine = { text: string; left: number; top: number; width: number; height: number; confidence: number };

declare global {
  interface Window {
    TripNavNativeOCR?: { postMessage(message: string): void };
    TripNavGPX?: { postMessage(message: string): void };
    resolveTripNavNativeOcr?: (id: string, lines: NativeOcrLine[] | null) => void;
  }
}

const nativeOcrPending = new Map<string, (lines: NativeOcrLine[] | null) => void>();
let nativeOcrSequence = 0;

if (typeof window !== "undefined") {
  window.resolveTripNavNativeOcr = (id, lines) => {
    nativeOcrPending.get(id)?.(lines);
    nativeOcrPending.delete(id);
  };
}

/** Longest side we decode to. Keeps phones under their canvas memory limits. */
const MAX_DECODE_SIDE = 3200;

type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

export async function readSheetPhotos(
  files: Blob[],
  onStatus?: (s: string) => void,
): Promise<PhotoResult[]> {
  const results: PhotoResult[] = [];
  if (!files.length) return results;
  if (typeof window !== "undefined" && window.TripNavNativeOCR) {
    onStatus?.("Reading photos on this phone…");
    for (const [index, file] of files.entries()) {
      const name = (file as File).name || `Photo ${index + 1}`;
      onStatus?.(files.length > 1 ? `Reading photo ${index + 1} of ${files.length} on this phone…` : "Reading the photo on this phone…");
      try {
        const lines = await recognizeNatively(file);
        if (!lines?.length) throw new PhotoError(RETAKE_MESSAGE);
        const ordered = lines.slice().sort((a, b) => a.top - b.top || a.left - b.left);
        const header = ordered.filter((line) => line.top < 0.18).map((line) => line.text).join("\n");
        const body = ordered.filter((line) => line.left < 0.73).map((line) => line.text).join("\n");
        const column = ordered.filter((line) => line.left >= 0.73 && line.top >= 0.18).map((line) => line.text).join("\n");
        const loads = mergeLoadColumn(normalizeSheetOcr(header, body), column);
        const text = loads.text;
        if (!judgeSheetText(text).ok) throw new PhotoError(RETAKE_MESSAGE);
        results.push({
          ok: true,
          name,
          text,
          incomplete: !FOOTER.test(ordered.map((line) => line.text).join("\n")),
          missingStops: loads.missingStops,
        });
      } catch (err) {
        results.push({ ok: false, name, reason: err instanceof PhotoError ? err.message : RETAKE_MESSAGE });
      }
    }
    return results;
  }
  let current = 0;
  const label = () => (files.length > 1 ? `Reading photo ${current + 1} of ${files.length}` : "Reading the photo");
  onStatus?.("Loading the text reader…");
  const { createWorker, OEM, PSM } = await import("tesseract.js");
  // One worker for the whole batch: loading the reader costs a few seconds.
  const worker: Worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/ocr/worker.min.js`,
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onStatus?.(`${label()}… ${Math.round(m.progress * 100)}%`);
      }
    },
  });
  try {
    await worker.setParameters({
      user_defined_dpi: "300",
    });
    for (current = 0; current < files.length; current++) {
      const file = files[current];
      const name = (file as File).name || `Photo ${current + 1}`;
      onStatus?.(`${label()}…`);
      try {
        results.push(await readOne(worker, file, name, PSM));
      } catch (err) {
        results.push({
          ok: false,
          name,
          reason: err instanceof PhotoError ? err.message : RETAKE_MESSAGE,
        });
      }
    }
  } finally {
    await worker.terminate();
  }
  return results;
}

async function recognizeNatively(file: Blob): Promise<NativeOcrLine[] | null> {
  const bitmap = await decode(file);
  const scale = Math.min(1, 2800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new PhotoError(RETAKE_MESSAGE);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if ("close" in bitmap) bitmap.close();
  const jpeg = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new PhotoError(RETAKE_MESSAGE)), "image/jpeg", 0.9));
  canvas.width = canvas.height = 0;
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const id = `ocr-${Date.now()}-${++nativeOcrSequence}`;
  const response = new Promise<NativeOcrLine[] | null>((resolve) => {
    const timeout = setTimeout(() => {
      nativeOcrPending.delete(id);
      resolve(null);
    }, 60000);
    nativeOcrPending.set(id, (lines) => { clearTimeout(timeout); resolve(lines); });
  });
  window.TripNavNativeOCR?.postMessage(JSON.stringify({ id, data: btoa(binary) }));
  return response;
}

class PhotoError extends Error {}

type PsmModes = { AUTO: PageSegmentationMode; SINGLE_BLOCK: PageSegmentationMode };

/** Every page of a Driver Directions sheet ends with this footer. */
const FOOTER = /report\s*name|driver\s*directions\s*-+\s*by\s*route|\bpage\s+\d+\s*$/im;

async function readOne(worker: Worker, file: Blob, name: string, psmModes: PsmModes): Promise<PhotoResult> {
  const read = await readGray(worker, await decodeToGray(file), psmModes);
  if (!read) return { ok: false, name, reason: RETAKE_MESSAGE };
  return { ok: true, name, text: read.text, thumb: thumbnail(read.page), incomplete: read.incomplete, missingStops: read.missingStops };
}

/**
 * OCR a decoded photo. When the cropped page never reaches the sheet's
 * footer, the crop may have cut the paper at a fold or shadow, silently
 * dropping stops and turns; the whole photo is read too and the read with
 * more of the sheet wins.
 */
export async function readGray(
  worker: Worker,
  gray: Gray,
  psmModes: PsmModes,
): Promise<{ text: string; page: Gray; incomplete: boolean; missingStops: number } | null> {
  const prepared = preparePage(gray);
  let best = await readPrepared(worker, prepared, psmModes);
  if (prepared.cropped && !best?.footer) {
    const whole = await readPrepared(worker, prepareWholePhoto(gray), psmModes);
    // On a tie the read that reached the footer saw the whole page.
    if (whole && (!best || whole.score > best.score || (whole.footer && whole.score >= best.score))) best = whole;
  }
  if (!best?.ok) return null;
  const page = rotate(best.image, best.degrees);
  // The load column, read on its own, counts the page's stops independently.
  const left = Math.round(page.width * 0.73);
  const column = await readText(worker, crop(page, { x: left, y: 0, w: Math.max(1, page.width - left), h: page.height }), psmModes.SINGLE_BLOCK);
  const loads = mergeLoadColumn(best.text, column);
  return { text: loads.text, page, incomplete: !best.footer, missingStops: loads.missingStops };
}

async function readPrepared(worker: Worker, prepared: Prepared, psmModes: PsmModes) {
  const candidates = rotationCandidates(prepared.landscape);
  let best: { text: string; score: number; ok: boolean; directions: number; degrees: number; footer: boolean; image: Gray } | null = null;
  for (const degrees of candidates) {
    const page = rotate(prepared.image, degrees);
    const header = crop(page, { x: 0, y: 0, w: page.width, h: Math.max(1, Math.round(page.height * 0.15)) });
    // Run numbers sit at the far right of the banner and can be missed when
    // the sheet is photographed against a textured background. Read that small
    // banner area separately at full resolution.
    const runHeader = crop(page, {
      x: Math.round(page.width * 0.75),
      y: Math.round(page.height * 0.01),
      w: Math.max(1, page.width - Math.round(page.width * 0.75)),
      h: Math.max(1, Math.round(page.height * 0.09)),
    });
    const body = crop(page, { x: 0, y: 0, w: Math.max(1, Math.round(page.width * 0.73)), h: page.height });
    const headerText = await readText(worker, header, psmModes.AUTO);
    const runText = await readText(worker, resize(runHeader, runHeader.width * 2, runHeader.height * 2), psmModes.AUTO);
    // The OCR engine sees the printed time, description, and directions only.
    // Its own text output preserves reading order better than recombining
    // individual word boxes from the table.
    for (const psm of [psmModes.AUTO, psmModes.SINGLE_BLOCK]) {
      const bodyText = await readText(worker, body, psm);
      const text = normalizeSheetOcr(`${headerText}\n${runText}`, bodyText);
      const q = judgeSheetText(text);
      const footer = FOOTER.test(bodyText);
      if (!best || q.score > best.score) best = { text, score: q.score, ok: q.ok, directions: q.directions, degrees, footer, image: prepared.image };
      // Don't spend time on alternate layouts once this read contains a solid
      // set of directions. Weak or partial reads get the fallback pass.
      // A read that reaches the footer saw the whole page.
      if (q.ok && footer && q.directions >= 5 && q.score >= 12) break;
    }
    if (best?.ok && best.directions >= 5 && best.score >= 12) break;
  }
  return best;
}

/** OCR one image region as text, preserving the engine's line order. */
async function readText(worker: Worker, page: Gray, mode: PageSegmentationMode): Promise<string> {
  await worker.setParameters({ tessedit_pageseg_mode: mode });
  // Outside a browser (tests and tools), hand the engine a PGM image instead.
  const image = typeof document === "undefined" ? grayToPgm(page) : grayToCanvas(page);
  const { data } = await worker.recognize(image, {}, { text: true });
  return data.text ?? "";
}

function shrink(g: Gray, longSide: number): Gray {
  const s = Math.min(1, longSide / Math.max(g.width, g.height));
  return s >= 1 ? g : resize(g, Math.max(1, Math.round(g.width * s)), Math.max(1, Math.round(g.height * s)));
}

/** Decode any phone photo to an upright grayscale buffer. */
async function decodeToGray(file: Blob): Promise<Gray> {
  const bitmap = await decode(file);
  const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new PhotoError("This browser can't open photos. Type the directions instead.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  if ("close" in bitmap) bitmap.close();
  const gray = rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h);
  canvas.width = canvas.height = 0;
  return gray;
}

async function decode(file: Blob): Promise<ImageBitmap> {
  const heic = await isHeic(file);
  try {
    // Safari opens HEIC itself; "from-image" applies the camera's rotation.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (!heic) throw new PhotoError(RETAKE_MESSAGE);
  }
  // Chrome, Firefox and Android browsers can't open iPhone HEIC photos.
  // Convert in the browser; the converter is only downloaded when needed.
  const { default: heic2any } = await import("heic2any");
  const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const jpeg = Array.isArray(converted) ? converted[0] : converted;
  try {
    return await createImageBitmap(jpeg, { imageOrientation: "from-image" });
  } catch {
    throw new PhotoError("This HEIC photo couldn't be opened. Set the camera to Most Compatible (JPEG) or take a screenshot of it.");
  }
}

export async function isHeic(file: Blob): Promise<boolean> {
  if (/^image\/hei[cf]/i.test(file.type)) return true;
  if (/\.hei[cf]$/i.test((file as File).name ?? "")) return true;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ftyp = String.fromCharCode(...head.slice(4, 8));
  const brand = String.fromCharCode(...head.slice(8, 12));
  return ftyp === "ftyp" && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand);
}

/** The page, upright and small enough to keep in memory: wide enough to read the header when enlarged. */
function thumbnail(g: Gray): string | undefined {
  try {
    const canvas = grayToCanvas(shrink(g, 900));
    const url = canvas.toDataURL("image/jpeg", 0.6);
    canvas.width = canvas.height = 0;
    return url;
  } catch {
    return undefined;
  }
}

/** A PGM file in a Node Buffer, which the engine reads outside a browser. */
function grayToPgm(g: Gray): ImageLike {
  const head = new TextEncoder().encode(`P5\n${g.width} ${g.height}\n255\n`);
  const out = new Uint8Array(head.length + g.data.length);
  out.set(head);
  out.set(g.data, head.length);
  const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): ImageLike } }).Buffer;
  return NodeBuffer.from(out);
}

function grayToCanvas(g: Gray): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PhotoError("This browser can't open photos. Type the directions instead.");
  const img = ctx.createImageData(g.width, g.height);
  const d = img.data;
  for (let i = 0, j = 0; j < g.data.length; i += 4, j++) {
    d[i] = d[i + 1] = d[i + 2] = g.data[j];
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
