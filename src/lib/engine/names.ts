const SUFFIX: Record<string, string> = {
  street: "st",
  st: "st",
  road: "rd",
  rd: "rd",
  avenue: "ave",
  ave: "ave",
  av: "ave",
  drive: "dr",
  dr: "dr",
  lane: "ln",
  ln: "ln",
  court: "ct",
  ct: "ct",
  place: "pl",
  pl: "pl",
  boulevard: "blvd",
  blvd: "blvd",
  parkway: "pkwy",
  pkwy: "pkwy",
  pky: "pkwy",
  circle: "cir",
  cir: "cir",
  trail: "trl",
  trl: "trl",
  terrace: "ter",
  ter: "ter",
  way: "way",
  crossing: "xing",
  xing: "xing",
  highway: "hwy",
  hwy: "hwy",
};

const DIRECTION_WORD: Record<string, string> = {
  north: "n", south: "s", east: "e", west: "w",
  northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};
const DIRECTION_KEY = new Set(Object.values(DIRECTION_WORD));

/**
 * A street key without its leading or trailing direction ("se maynard rd" →
 * "maynard rd"), for sheets that drop the prefix the map keeps, or the other
 * way round. Returns the key unchanged when nothing is left but a suffix.
 */
export function withoutDirection(key: string): string {
  const parts = key.split(" ");
  if (parts.length > 2 && DIRECTION_KEY.has(parts[0])) parts.shift();
  if (parts.length > 2 && DIRECTION_KEY.has(parts[parts.length - 1])) parts.pop();
  return parts.join(" ");
}

/** Stable street key: "Morgan Street" and "MORGAN ST" both become "morgan st". */
/**
 * The sheet tags some names with a ZIP code ("CHURCH ST 27560", "CHURCH ST
 * ,27560") or a county ("VANDIVER WAY-CHATHAM CO"). Neither is part of the name.
 */
export function withoutPlaceTags(raw: string): string {
  return raw
    .replace(/\s*-\s*[A-Za-z]+\s+CO(?:UNTY)?\s*$/i, "")
    .replace(/\s*,?\s*\b\d{5}\s*$/, "")
    .trim();
}

/**
 * A roundabout, ramp or highway exit named only as such on the sheet. The bus
 * drives through it and the next line names the road it leaves on.
 */
export function isPassThrough(street: string): boolean {
  return /^(?:the\s+)?(?:roundabout|traffic\s+circle|rotary|ramp|exit\s*\d+[a-z]?)$/i.test(street.trim());
}

export function canonicalKey(raw: string): string {
  let s = withoutPlaceTags(raw)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/\b(highway|hwy)\b/g, " ").replace(/\s+/g, " ").trim();
  const route = s.match(/^(nc|us|sr|i|interstate)\s*(\d+[a-z]?)$/);
  if (route) {
    const head = route[1];
    const prefix = head === "i" || head === "interstate" ? "i" : head === "us" ? "us" : head === "sr" ? "sr" : "nc";
    return `${prefix} ${route[2]}`;
  }
  const parts = s.split(" ").filter(Boolean);
  // "Southeast Maynard Road" and "SE MAYNARD RD" are one street.
  if (parts.length > 1 && DIRECTION_WORD[parts[0]]) parts[0] = DIRECTION_WORD[parts[0]];
  if (parts.length > 1 && DIRECTION_WORD[parts[parts.length - 1]]) parts[parts.length - 1] = DIRECTION_WORD[parts[parts.length - 1]];
  const last = parts.length > 1 && DIRECTION_KEY.has(parts[parts.length - 1]) ? parts.length - 2 : parts.length - 1;
  if (last >= 0 && SUFFIX[parts[last]]) {
    parts[last] = SUFFIX[parts[last]];
  }
  return parts.join(" ");
}

export function routeKeyFromRef(ref: string, network: string): string | null {
  const net = network.toUpperCase();
  const num = ref.replace(/^(NC|US|I|SR)[\s-]*/i, "").trim().toLowerCase();
  if (!num || !/^\d+[a-z]?$/.test(num)) return null;
  if (net.includes("US:I") || net.includes("INTERSTATE")) return `i ${num}`;
  if (net.includes("US:US")) return `us ${num}`;
  if (net.includes("US:NC") || net.includes("US-STATE") || net.includes("US:SR")) return `nc ${num}`;
  return null;
}

const STREET_WORD =
  /\b(rd|road|st|street|dr|drive|ln|lane|pkwy|parkway|ave|avenue|ct|court|blvd|boulevard|cir|circle|pl|place|trl|trail|ter|terrace|way)\b/i;

/** "OAK HS" is a campus, not a named street. "Oak School Road" is a street. */
export function looksLikePlace(raw: string): boolean {
  // "MAPLE DRIVE MS" is the middle school on Maple Drive; "OAK SCHOOL RD" is a road.
  const words = raw.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9\s]/g, " ").trim().split(/\s+/).filter((w) => !/^\d+$/.test(w));
  if (/^(hs|es|ms|elem|elementary|elementry|school|highschool|middleschool)$/.test(words.at(-1) ?? "")) return true;
  if (STREET_WORD.test(raw)) return false;
  return /\b(hs|es|ms|elem|high\s*school|elementary|elementry|middle\s*school|school)\b/i.test(raw);
}

export function schoolSig(name: string): { tokens: string; level: string } {
  // Case and punctuation don't matter, nor a bell number or note: "OAK HS 16 (DB)".
  let s = placeName(name)
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let level = "";
  if (/\b(high\s+school|highschool|hs)\b/.test(s)) level = "high";
  else if (/\b(elementary|elementry|elem|es)\b/.test(s)) level = "elem";
  else if (/\b(middle|ms)\b/.test(s)) level = "mid";
  s = s.replace(
    /\b(high\s+school|elementary\s+school|middle\s+school|highschool|middleschool|school|high|elementary|elementry|elem|middle|hs|es|ms)\b/g,
    " ",
  );
  const tokens = s
    .split(" ")
    .filter((t) => t && !["the", "of", "and", "at", "magnet", "academy"].includes(t))
    // "Birch Drive Elementary" is printed "BIRCH DR ES".
    .map((t) => SUFFIX[t] ?? t)
    .sort();
  return { tokens: tokens.join(" "), level };
}

export function sameSchool(
  a: { tokens: string; level: string },
  b: { tokens: string; level: string },
): boolean {
  if (!a.tokens || a.tokens !== b.tokens) return false;
  if (!a.level || !b.level) return true;
  return a.level === b.level;
}

/** "OAK HS" -> "Oak High School" for geocoders. */
/** Just the place name from a stop line: "Deadhead - 1 OAK HS 0 0 @AB.012" -> "OAK HS". */
export function placeName(raw: string): string {
  return raw
    .replace(/^\s*deadhead\s*-?\s*/i, "")
    .replace(/^\s*school\s*:\s*/i, "")
    .replace(/\s+\S{1,3}\s+\S{1,3}\s+[0-9@][0-9A-Za-z]{2}\.?[0-9A-Za-z]{3}\s*$/, "")
    .replace(/\s*-?\s*\(?\bdoorside\b\)?.*$/i, "")
    .replace(/^\d+\s+/, "")
    .trim();
}

export function expandPlaceQuery(raw: string): string {
  return placeName(raw)
    .replace(/\bHS\b/gi, "High School")
    .replace(/\b(?:ES|ELEM)\b/gi, "Elementary School")
    .replace(/\bMS\b/gi, "Middle School");
}

export function titleCaseStreet(raw: string): string {
  const key = canonicalKey(raw);
  if (/^(nc|us|sr|i) \d/.test(key)) {
    const [p, n] = key.split(" ");
    const label = p === "i" ? "I" : p === "us" ? "US" : p === "sr" ? "SR" : "NC";
    return `${label} ${n}`;
  }
  return withoutPlaceTags(raw)
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bPkwy\b/g, "Pkwy")
    .replace(/\bHs\b/g, "HS");
}
