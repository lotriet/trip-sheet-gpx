/** Read a photo of a trip sheet. The OCR engine is loaded in the browser; the photo is not uploaded. */

export async function readSheetPhoto(file: Blob, onStatus?: (s: string) => void): Promise<string> {
  onStatus?.("Reading the photo…");
  const prepared = await boostContrast(file);
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", undefined, {
    workerPath: `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/ocr/worker.min.js`,
    logger: (m) => {
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        onStatus?.(`Reading the photo… ${Math.round(m.progress * 100)}%`);
      }
    },
  });
  try {
    const result = await worker.recognize(prepared);
    return result.data.text ?? "";
  } finally {
    await worker.terminate();
  }
}

async function boostContrast(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const maxW = 1600;
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 16) {
    const y = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const span = Math.max(40, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    const v = Math.max(0, Math.min(255, ((y - min) / span) * 255));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ?? file;
}
