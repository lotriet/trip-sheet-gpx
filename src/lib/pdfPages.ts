/**
 * A PDF trip sheet is read the same way as photos: each page becomes one image,
 * then the photo reader takes it. One page or many. The file stays on the phone.
 *
 * The PDF reader is the Mozilla build in /pdf, loaded in the browser. It is not
 * bundled, so the page images never leave the phone.
 */

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

type PdfPage = {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy?: () => void;
};

type PdfjsLib = {
  getDocument: (src: { data: Uint8Array; isEvalSupported?: boolean }) => { promise: Promise<PdfDoc> };
  GlobalWorkerOptions: { workerSrc: string };
};

let loading: Promise<PdfjsLib> | null = null;

function loadPdfjs(): Promise<PdfjsLib> {
  if (loading) return loading;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const workerSrc = `${base}/pdf/pdf.worker.min.mjs`;
  const g = globalThis as typeof globalThis & { pdfjsLib?: PdfjsLib };
  loading = new Promise((resolve, reject) => {
    if (g.pdfjsLib?.getDocument) {
      g.pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      resolve(g.pdfjsLib);
      return;
    }
    const script = document.createElement("script");
    script.type = "module";
    script.src = `${base}/pdf/pdf.min.mjs`;
    script.onload = () => {
      if (!g.pdfjsLib?.getDocument) {
        reject(new Error("Couldn't load the PDF reader."));
        return;
      }
      g.pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
      resolve(g.pdfjsLib);
    };
    script.onerror = () => reject(new Error("Couldn't load the PDF reader. Check the connection, or photograph the pages."));
    document.head.appendChild(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

export async function pdfToPageImages(file: File, onStatus?: (s: string) => void): Promise<File[]> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  let doc: PdfDoc;
  try {
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch {
    throw new Error(`Couldn't open ${file.name}. If it has a password, remove it, or photograph the pages.`);
  }
  if (!doc.numPages) {
    doc.destroy?.();
    throw new Error(`${file.name} has no pages.`);
  }
  const stem = file.name.replace(/\.pdf$/i, "") || "PDF";
  const out: File[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onStatus?.(doc.numPages === 1 ? `Opening ${stem}…` : `Opening ${stem}, page ${i} of ${doc.numPages}…`);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const long = Math.max(base.width, base.height) || 1;
      const viewport = page.getViewport({ scale: Math.min(2.4, 2200 / long) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser can't read a PDF. Photograph the pages instead.");
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error(`Couldn't read page ${i} of ${stem}.`);
      const name = doc.numPages === 1 ? `${stem}.jpg` : `${stem} page ${i}.jpg`;
      out.push(new File([blob], name, { type: "image/jpeg" }));
    }
  } finally {
    doc.destroy?.();
  }
  return out;
}
