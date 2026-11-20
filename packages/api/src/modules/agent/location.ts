// Location helpers for the weather tool. Pure, no network.

/** Time words that are not part of a place name ("weather in Sweden right now"). */
const TIME_PHRASE =
  /\b(?:right\s+now|just\s+now|now|today|tonight|tomorrow|currently|at\s+the\s+moment|at\s+present|this\s+(?:morning|afternoon|evening|week|weekend)|later(?:\s+today)?)\b/gi;

/** Filler that can trail a place in speech ("in Paris please", "in Rome like"). */
// "right" alone is what a two-word extractor left of "right now".
const TRAILING_FILLER = /\s+(?:please|like|then|though|outside|there|right)$/i;
const LEADING_FILLER = /^(?:in|for|at|the|city\s+of)\s+/i;

/**
 * Strip time words and filler from a spoken location:
 * "Sweden right now" → "Sweden", "Stockholm today" → "Stockholm".
 */
export function cleanLocation(raw: string): string {
  let s = raw.replace(TIME_PHRASE, " ").replace(/[?.!,;:]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(LEADING_FILLER, "").replace(TRAILING_FILLER, "").trim();
  }
  return s;
}

/**
 * Place named after the last "in/for/at" once time phrases are removed:
 * "What's the weather in Sweden right now?" → "Sweden",
 * "weather tomorrow in New York City" → "New York City".
 */
export function extractWeatherLocation(text: string): string | null {
  const withoutTime = text.replace(TIME_PHRASE, " ");
  const matches = [
    ...withoutTime.matchAll(
      /\b(?:in|for|at)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*(?:\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*){0,3})/gi,
    ),
  ];
  for (let i = matches.length - 1; i >= 0; i--) {
    const cleaned = cleanLocation(matches[i]?.[1] ?? "");
    if (cleaned) return cleaned;
  }
  return null;
}

/**
 * Capitals for countries people are likely to ask about, keyed by ISO 3166-1
 * alpha-2 (Open-Meteo `country_code`). A country outside this list gets a
 * "which city?" follow-up instead of a guess.
 */
export const CAPITALS: Readonly<Record<string, string>> = {
  SE: "Stockholm",
  NO: "Oslo",
  DK: "Copenhagen",
  FI: "Helsinki",
  IS: "Reykjavik",
  EE: "Tallinn",
  LV: "Riga",
  LT: "Vilnius",
  GB: "London",
  IE: "Dublin",
  FR: "Paris",
  DE: "Berlin",
  NL: "Amsterdam",
  BE: "Brussels",
  LU: "Luxembourg",
  CH: "Bern",
  AT: "Vienna",
  ES: "Madrid",
  PT: "Lisbon",
  IT: "Rome",
  GR: "Athens",
  PL: "Warsaw",
  CZ: "Prague",
  SK: "Bratislava",
  HU: "Budapest",
  RO: "Bucharest",
  BG: "Sofia",
  HR: "Zagreb",
  SI: "Ljubljana",
  RS: "Belgrade",
  UA: "Kyiv",
  TR: "Ankara",
  RU: "Moscow",
  US: "Washington",
  CA: "Ottawa",
  MX: "Mexico City",
  BR: "Brasília",
  AR: "Buenos Aires",
  CL: "Santiago",
  CO: "Bogotá",
  PE: "Lima",
  JP: "Tokyo",
  CN: "Beijing",
  KR: "Seoul",
  IN: "New Delhi",
  PK: "Islamabad",
  TH: "Bangkok",
  VN: "Hanoi",
  ID: "Jakarta",
  PH: "Manila",
  MY: "Kuala Lumpur",
  SG: "Singapore",
  AU: "Canberra",
  NZ: "Wellington",
  EG: "Cairo",
  MA: "Rabat",
  NG: "Abuja",
  KE: "Nairobi",
  ZA: "Pretoria",
  ET: "Addis Ababa",
  SA: "Riyadh",
  AE: "Abu Dhabi",
  IL: "Jerusalem",
  IR: "Tehran",
  IQ: "Baghdad",
};
