// Copies the text reader's worker, engine and English data into public/ocr/,
// so the page never fetches them from a CDN and they can be saved for offline use.
// Runs before `next dev` and `next build`; the copies are not committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "ocr");
const mod = (p) => join(root, "node_modules", p);

mkdirSync(out, { recursive: true });
const files = [
  [mod("tesseract.js/dist/worker.min.js"), "worker.min.js"],
  // OEM.LSTM_ONLY picks one of these by the browser's SIMD support.
  [mod("tesseract.js-core/tesseract-core-lstm.wasm.js"), "tesseract-core-lstm.wasm.js"],
  [mod("tesseract.js-core/tesseract-core-simd-lstm.wasm.js"), "tesseract-core-simd-lstm.wasm.js"],
  [mod("tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js"), "tesseract-core-relaxedsimd-lstm.wasm.js"],
  // LSTM-only reads the "best_int" English model.
  [mod("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"), "eng.traineddata.gz"],
];
for (const [from, name] of files) copyFileSync(from, join(out, name));
console.log(`Copied ${files.length} text reader files to public/ocr/`);
