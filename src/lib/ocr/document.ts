/** Turn OCR's page text into the route fields the sheet actually prints. */

const TIME = /^\W*\d{1,2}\s*:\s*\d{2}\s*[AP]M\b/i;
const BARE_TIME = /^\W*\d{1,2}\s*:\s*\d{2}\s*[AP]M\s*$/i;
const DIRECTION = /^\W*(?:proceed|procead|continue|right|left|rt\b|lt\b|turn\s*around|tum\s*around|u[\s-]?turn)\b/i;

function headerField(text: string, label: string): string {
  const match = text.match(new RegExp(`\\b${label}[ \\t]*[:_][ \\t]*([^\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function usableDescription(value: string): string {
  // The Run field can bleed onto the description line, with or without its colon.
  const cleaned = value.replace(/\s+Run\s*:.*$/i, "").replace(/\s+Run\s*$/i, "").trim();
  const letters = cleaned.match(/[A-Za-z]/g)?.length ?? 0;
  return letters < 4 || !/^[A-Z0-9]/i.test(cleaned) || /driver directions|according to TIMS|confidential/i.test(cleaned) ? "" : cleaned;
}

function routeNumber(text: string): string {
  const value = text.match(/\bRoute\s*[:_]\s*([A-Z]{1,4}\s*\d{2,6})\b/i)?.[1]?.replace(/\s+/g, "") ?? "";
  // On these sheets the printed GH prefix is occasionally read as GHI/ GHL.
  return value.replace(/^GH[IL](?=\d)/i, "GH");
}

function runNumber(text: string): string {
  const match = text.match(/\bRun\s*[:_]\s*((?:\d\s*){3})\s*[.,]\s*((?:\d\s*){3})\b/i);
  return match ? `${match[1].replace(/\s/g, "")}.${match[2].replace(/\s/g, "")}` : "";
}

function bodyDescription(text: string): string {
  // In a left-column crop the leading "Descr" may be outside the image.
  const match = text.match(/\b(?:description|[a-z]*iption)\s*[:_]\s*([A-Z0-9][A-Z0-9 ()&'-]{2,50})/i);
  return usableDescription(match?.[1] ?? "");
}

function cleanContent(line: string): string {
  return line
    .replace(/\bProcead\b/gi, "Proceed")
    .replace(/\bTu[mnr]\b/gi, "Turn")
    // Common misreads of the two turn words at the start of a direction.
    .replace(/^(\W*)Le[ftl][tfl1i]\b/i, "$1Left")
    .replace(/^(\W*)R[il1][gq]h?[nhr]t\b/i, "$1Right")
    .replace(/\bPK\s+WY\b/gi, "PKWY")
    .replace(/\s+/g, " ")
    .trim();
}

function canContinue(line: string): boolean {
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length < 2) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.85 && /^[A-Z0-9 &@().,'/#-]+$/.test(line);
}

export function normalizeSheetOcr(headerRaw: string, bodyRaw: string): string {
  const header = `${headerRaw}\n${bodyRaw.slice(0, 400)}`;
  const route = routeNumber(header);
  const run = runNumber(headerRaw) || runNumber(bodyRaw);
  const description =
    usableDescription(headerField(headerRaw, "Description")) ||
    usableDescription(headerField(bodyRaw, "Description")) ||
    bodyDescription(bodyRaw);
  const result: string[] = [];
  if (route) result.push(`Route: ${route}`);
  if (description) result.push(`Description: ${description}`);
  if (run) result.push(`Run: ${run}`);

  let started = false;
  let previousWasContent = false;
  for (const raw of bodyRaw.replace(/\r/g, "").split("\n")) {
    const line = cleanContent(raw);
    if (!line) continue;
    if (TIME.test(line) || DIRECTION.test(line)) {
      started = true;
      previousWasContent = true;
      result.push(line);
      continue;
    }
    // A stop line read as just its time: the description came out as its own
    // line ("Deadhead - SCHOOL: OAK HS" is mixed case, so canContinue misses it).
    if (started && previousWasContent && BARE_TIME.test(result[result.length - 1]) && /[A-Za-z]{3,}/.test(line)) {
      result[result.length - 1] += ` ${line}`;
      continue;
    }
    // A long stop or street name sometimes wraps onto a second printed line.
    if (started && previousWasContent && canContinue(line)) {
      result[result.length - 1] += ` ${line}`;
      continue;
    }
    previousWasContent = false;
  }
  return result.join("\n");
}

const LOAD_ROW = /^\W*(\d{1,3})\s+(\d{1,3})(?:\s+([0-9@][0-9A-Za-z]{2}\.[0-9A-Za-z]{3}))?\W*$/;

/**
 * Join the Stop Load / Run Ld / Stop ID column, read on its own, to the stop
 * lines. Each stop has one row, so more rows than stop lines means stops were
 * missed. Rows are joined only when the counts match, so a number can't land
 * on the wrong stop.
 */
export function mergeLoadColumn(text: string, columnRaw: string): { text: string; missingStops: number } {
  const rows = columnRaw
    .split("\n")
    .map((line) => line.trim().match(LOAD_ROW))
    .filter((m): m is RegExpMatchArray => !!m);
  const lines = text.split("\n");
  const stopLines = lines.flatMap((line, i) => (TIME.test(line) ? [i] : []));
  const missingStops = Math.max(0, rows.length - stopLines.length);
  if (rows.length && rows.length === stopLines.length) {
    stopLines.forEach((at, k) => {
      const [, stopLoad, runLoad, id] = rows[k];
      if (id && !/\d{1,3}\s+\d{1,3}\s+\S+\.\S{3}\s*$/.test(lines[at])) lines[at] = `${lines[at]} ${stopLoad} ${runLoad} ${id}`;
    });
  }
  return { text: lines.join("\n"), missingStops };
}
