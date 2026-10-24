/**
 * Decide which OCR lines to keep and whether a photo was read well enough to use.
 * Pure functions so they can be tested without a browser.
 */

export type OcrLine = { text: string; confidence: number };

/** Keep readable lines; structured low-confidence lines can still be useful to edit. */
export const MIN_LINE_CONFIDENCE = 40;

const TIME_LINE = /^\W*\d{1,2}\s?:\s?\d{2}\s*[AP]\.?M\b/i;
const DIRECTION_LINE = /^\W*(?:proceed|continue|right|left|rt|lt|turn\s*around|u[\s-]?turn)\b.*\b(?:on|onto|to)\b/i;
const HEADER_LINE = /\b(?:route|run)\s*:|driver directions/i;
const STRUCTURED_LINE = /^\W*(?:\d{1,2}\s*[:.]\s*\d{2}\s*[AP]\.?M\b|(?:route|run|description)\s*:|proceed|continue|right|left|rt\b|lt\b|turn\s*around|u[\s-]?turn)\b/i;

/** Keep lines that are confident and contain at least one real word or a time. */
export function keepLines(lines: OcrLine[]): string[] {
  return lines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, " ").trim() }))
    // Tesseract sometimes gives a real turn or time a low confidence score
    // when the print is small. Keep those recognizable sheet-shaped lines so
    // the route editor can still correct them, while rejecting low-confidence
    // background fragments.
    .filter((line) => line.confidence >= MIN_LINE_CONFIDENCE || (line.confidence >= 25 && STRUCTURED_LINE.test(line.text)))
    .map((line) => line.text)
    .filter((text) => /[A-Za-z]{3,}/.test(text) || /\d{1,2}:\d{2}/.test(text));
}

export type Quality = { ok: boolean; directions: number; times: number; header: boolean; score: number };

/** Score how much of the text looks like a trip sheet. */
export function judgeSheetText(text: string): Quality {
  let directions = 0;
  let times = 0;
  let header = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (TIME_LINE.test(line)) times++;
    else if (DIRECTION_LINE.test(line)) directions++;
    if (HEADER_LINE.test(line)) header = true;
  }
  const score = directions + 2 * times + (header ? 2 : 0);
  // A continuation page can have only a couple of lines; one stop or two
  // directions plus the header is enough to be worth showing.
  const ok = directions + times >= 2 || (header && directions + times >= 1);
  return { ok, directions, times, header, score };
}

export const RETAKE_MESSAGE =
  "Couldn't read this photo. Retake it with the sheet flat, filling the screen, close up and well lit.";
