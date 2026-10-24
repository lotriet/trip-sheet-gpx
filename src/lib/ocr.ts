/**
 * Read photos of trip sheets in the browser. Photos are never uploaded.
 *
 * Steps per photo: decode it (HEIC included) upright, find the white page and
 * blank the background around it, scale the page so the print is ~30 px tall,
 * flatten the light, then OCR. A sideways or upside-down page is retried in the
 * other direction. Text that doesn't look like a trip sheet is refused rather
 * than passed on as gibberish.
 */

import { crop, preparePage, resize, rgbaToGray, rotate, rotationCandidates, type Gray } from "./ocr/prep";
import { judgeSheetText, keepLines, RETAKE_MESSAGE, type OcrLine } from "./ocr/quality";
import type { PSM as PageSegmentationMode } from "tesseract.js";

export type PhotoResult =
  | { ok: true; name: string; text: string; /** Small JPEG of the page as read, for telling pages apart. */ thumb?: string }
  | { ok: false; name: string; reason: string };

/** Longest side we decode to. Keeps phones under their canvas memory limits. */
const MAX_DECODE_SIDE = 3200;

type Worker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

export async function readSheetPhotos(
  files: Blob[],
  onStatus?: (s: string) => void,
): Promise<PhotoResult[]> {
  const results: PhotoResult[] = [];
  if (!files.length) return results;
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

class PhotoError extends Error {}

async function readOne(
  worker: Worker,
  file: Blob,
  name: string,
  psmModes: { AUTO: PageSegmentationMode; SINGLE_BLOCK: PageSegmentationMode },
): Promise<PhotoResult> {
  const gray = await decodeToGray(file);
  const prepared = preparePage(gray);
  let candidates = rotationCandidates(prepared.landscape);
  if (!prepared.convincing) {
    // No clear white page in the photo. Take a quick low-resolution look
    // first, so a photo of a seat or a blurry shot is turned down in a second
    // or two instead of a full read.
    const keep: number[] = [];
    for (const degrees of candidates) {
      const preview = shrink(rotate(prepared.image, degrees), 1200);
      let q = judgeSheetText(await readLines(worker, preview, psmModes.AUTO));
      if (q.directions + q.times + (q.header ? 1 : 0) === 0) {
        q = judgeSheetText(await readLines(worker, preview, psmModes.SINGLE_BLOCK));
      }
      if (q.directions + q.times + (q.header ? 1 : 0) > 0) keep.push(degrees);
    }
    if (!keep.length) return { ok: false, name, reason: RETAKE_MESSAGE };
    candidates = keep;
  }
  let best: { text: string; score: number; ok: boolean; directions: number; degrees: number } | null = null;
  for (const degrees of candidates) {
    const page = rotate(prepared.image, degrees);
    // Auto layout handles tables and uneven columns better; the block mode is
    // a second chance for sheets printed as one tightly packed text block.
    for (const psm of [psmModes.AUTO, psmModes.SINGLE_BLOCK]) {
      const text = await readSheetColumns(worker, page, psm, psmModes);
      const q = judgeSheetText(text);
      if (!best || q.score > best.score) best = { text, score: q.score, ok: q.ok, directions: q.directions, degrees };
      // Don't spend time on alternate layouts once this read contains a solid
      // set of directions. Weak or partial reads get the fallback pass.
      if (q.ok && q.directions >= 5 && q.score >= 12) break;
    }
    if (best?.ok && best.directions >= 5 && best.score >= 12) break;
  }
  if (!best?.ok) return { ok: false, name, reason: RETAKE_MESSAGE };
  return { ok: true, name, text: best.text, thumb: thumbnail(rotate(prepared.image, best.degrees)) };
}

/** Read only the sheet's useful columns; the load and ID columns never enter body OCR. */
async function readSheetColumns(
  worker: Worker,
  page: Gray,
  bodyMode: PageSegmentationMode,
  psm: { AUTO: PageSegmentationMode; SINGLE_BLOCK: PageSegmentationMode },
): Promise<string> {
  const headerHeight = Math.max(1, Math.round(page.height * 0.14));
  const descriptionWidth = Math.max(1, Math.round(page.width * 0.73));
  const header = crop(page, { x: 0, y: 0, w: page.width, h: headerHeight });
  const body = crop(page, { x: 0, y: 0, w: descriptionWidth, h: page.height });

  // Read Route/Description/Run from the short full-width banner, then read
  // the body after physically removing Stop Load, Run Ld, and Stop ID.
  const headerText = await readLines(worker, header, psm.SINGLE_BLOCK, 1);
  const bodyText = await readLines(worker, body, bodyMode, 1);
  const bodyLines = bodyText
    .split("\n")
    .filter((line) => !/^(?:route|description|run)\s*:/i.test(line));
  const headerLines = headerText.split("\n").filter(Boolean);
  return [...headerLines, ...bodyLines].join("\n");
}

/** OCR an image and return only the confident, word-like lines. */
async function readLines(
  worker: Worker,
  page: Gray,
  mode: PageSegmentationMode,
  maxColumnFraction = 0.73,
): Promise<string> {
  await worker.setParameters({ tessedit_pageseg_mode: mode });
  const { data } = await worker.recognize(grayToCanvas(page), {}, { text: true, blocks: true });
  const positioned: { text: string; x: number; y: number; confidence: number }[] = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const words = line.words ?? [];
        if (!words.length) {
          positioned.push({ text: line.text, x: 0, y: 0, confidence: line.confidence });
          continue;
        }

        // The full-page preview uses a positional fallback. Main OCR calls
        // pass physically cropped regions, so this is only a safety net.
        for (const word of words) {
          if (word.bbox.x0 >= page.width * maxColumnFraction) continue;
          positioned.push({
            text: word.text,
            x: word.bbox.x0,
            y: (word.bbox.y0 + word.bbox.y1) / 2,
            confidence: word.confidence,
          });
        }
      }
    }
  }

  // Tesseract can return separate blocks in column order (left column, then
  // legal text, then right column) instead of page order. Reassemble the kept
  // words into visual rows and read those rows top to bottom, left to right.
  positioned.sort((a, b) => a.y - b.y || a.x - b.x);
  const rowTolerance = Math.max(8, page.height * 0.007);
  const rows: { y: number; words: typeof positioned; confidence: number }[] = [];
  for (const word of positioned) {
    let row = rows.at(-1);
    if (!row || word.y - row.y > rowTolerance) {
      row = { y: word.y, words: [], confidence: 0 };
      rows.push(row);
    }
    row.words.push(word);
  }

  const boilerplate = /driver directions by route|directions cannot be run|according to tims|medians in the roadway|private streets|provided in confidence|sole purpose of transporting|may not be disclosed|third party|district office|report name|page\s+\d+|stop time\s+description|^stop$/i;
  const lines: OcrLine[] = rows
    .map((row) => {
      const words = row.words.sort((a, b) => a.x - b.x);
      return {
        text: words.map((word) => word.text).join(" ").replace(/\s+/g, " ").trim(),
        confidence: words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, words.length),
      };
    })
    .filter((line) => !boilerplate.test(line.text));
  return keepLines(lines).join("\n");
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
