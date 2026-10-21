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

/** Stable street key: "Morgan Street" and "MORGAN ST" both become "morgan st". */
export function canonicalKey(raw: string): string {
  let s = raw
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
  if (parts.length && SUFFIX[parts[parts.length - 1]]) {
    parts[parts.length - 1] = SUFFIX[parts[parts.length - 1]];
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
  if (STREET_WORD.test(raw)) return false;
  return /\b(hs|es|ms|high\s+school|elementary|middle\s+school|school)\b/i.test(raw);
}

export function schoolSig(name: string): { tokens: string; level: string } {
  let s = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  let level = "";
  if (/\b(high\s+school|highschool|hs)\b/.test(s)) level = "high";
  else if (/\b(elementary|elem|es)\b/.test(s)) level = "elem";
  else if (/\b(middle|ms)\b/.test(s)) level = "mid";
  s = s.replace(
    /\b(high\s+school|elementary\s+school|middle\s+school|highschool|school|high|elementary|middle|hs|es|ms)\b/g,
    " ",
  );
  const tokens = s
    .split(" ")
    .filter((t) => t && !["the", "of", "and", "at"].includes(t))
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
export function expandPlaceQuery(raw: string): string {
  let s = raw.replace(/^\s*school\s*:\s*/i, "").trim();
  s = s.replace(/\bHS\b/gi, "High School").replace(/\bES\b/gi, "Elementary School").replace(/\bMS\b/gi, "Middle School");
  return s;
}

export function titleCaseStreet(raw: string): string {
  const key = canonicalKey(raw);
  if (/^(nc|us|sr|i) \d/.test(key)) {
    const [p, n] = key.split(" ");
    const label = p === "i" ? "I" : p === "us" ? "US" : p === "sr" ? "SR" : "NC";
    return `${label} ${n}`;
  }
  return raw
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\bPkwy\b/g, "Pkwy")
    .replace(/\bHs\b/g, "HS");
}
