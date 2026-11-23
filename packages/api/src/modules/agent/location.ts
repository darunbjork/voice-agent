// Location helpers for the weather tool. Pure, no network.

/** Time words that are not part of a place name ("weather in Sweden right now"). */
const TIME_PHRASE =
  /\b(?:right\s+now|just\s+now|now|today|tonight|(?:the\s+)?day\s+after\s+tomorrow|tomorrow|currently|at\s+the\s+moment|at\s+present|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|weekend|month)|later(?:\s+today)?|in\s+(?:a\s+few|\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?|(?:on\s+|this\s+|next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?)\b/gi;

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
      /\b(?:in|for|at)\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*(?:,?\s+[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*){0,3})/gi,
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

// ── Forecast day ────────────────────────────────────────────────────────────

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const SMALL_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Open-Meteo's daily forecast covers today + 6 days. */
export const MAX_FORECAST_DAYS = 7;

export type ForecastDay =
  | { kind: "current" }
  | { kind: "day"; offset: number; label: string }
  /** A time we cannot forecast (next month, in 10 days, …). */
  | { kind: "unsupported"; phrase: string };

/**
 * Which day the user asks about. `today` is the weekday (0 = Sunday) where
 * the user is; the forecast index is then the offset from today.
 */
export function parseForecastDay(text: string, today: number): ForecastDay {
  const t = text.toLowerCase();
  if (/\b(?:the\s+)?day\s+after\s+tomorrow\b/.test(t)) {
    return { kind: "day", offset: 2, label: "the day after tomorrow" };
  }
  if (/\btomorrow\b/.test(t)) return { kind: "day", offset: 1, label: "tomorrow" };

  const inDays = t.match(/\bin\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\b/);
  if (inDays?.[1]) {
    const n = /^\d+$/.test(inDays[1]) ? Number(inDays[1]) : (SMALL_NUMBERS[inDays[1]] ?? 0);
    if (n >= MAX_FORECAST_DAYS) return { kind: "unsupported", phrase: `in ${n} days` };
    return n === 0
      ? { kind: "current" }
      : { kind: "day", offset: n, label: n === 1 ? "tomorrow" : `in ${n} days` };
  }

  const next = t.match(/\bnext\s+(week|month|year)\b/);
  if (next?.[1]) return { kind: "unsupported", phrase: `next ${next[1]}` };

  if (/\b(?:this\s+|next\s+)?weekend\b/.test(t)) {
    const offset = (6 - today + 7) % 7; // Saturday
    return { kind: "day", offset, label: offset === 0 ? "today (Saturday)" : "on Saturday" };
  }

  const weekday = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/);
  if (weekday?.[1]) {
    const target = WEEKDAYS.indexOf(weekday[1]);
    const offset = (target - today + 7) % 7;
    const name = weekday[1].charAt(0).toUpperCase() + weekday[1].slice(1);
    return offset === 0 ? { kind: "current" } : { kind: "day", offset, label: `on ${name}` };
  }
  return { kind: "current" };
}

// ── Regions and countries ───────────────────────────────────────────────────

/**
 * Places too big for one weather report. The geocoder happily matches them to
 * villages elsewhere ("Middle East" → a US hamlet of 1,872 people,
 * "Scandinavia" → a US town), so they are caught before geocoding.
 */
const REGIONS: Readonly<Record<string, string>> = {
  "middle east": "the Middle East",
  "the middle east": "the Middle East",
  "near east": "the Near East",
  europe: "Europe",
  asia: "Asia",
  africa: "Africa",
  "north america": "North America",
  "south america": "South America",
  "latin america": "Latin America",
  "central america": "Central America",
  america: "America",
  oceania: "Oceania",
  antarctica: "Antarctica",
  arctic: "the Arctic",
  "the arctic": "the Arctic",
  scandinavia: "Scandinavia",
  nordics: "the Nordics",
  "the nordics": "the Nordics",
  "nordic countries": "the Nordic countries",
  balkans: "the Balkans",
  "the balkans": "the Balkans",
  caribbean: "the Caribbean",
  "the caribbean": "the Caribbean",
  mediterranean: "the Mediterranean",
  "the mediterranean": "the Mediterranean",
  "southeast asia": "Southeast Asia",
  "south east asia": "Southeast Asia",
  "east asia": "East Asia",
  "south asia": "South Asia",
  "central asia": "Central Asia",
  "the gulf": "the Gulf",
  "persian gulf": "the Persian Gulf",
  "the persian gulf": "the Persian Gulf",
  "gulf states": "the Gulf states",
  "western europe": "Western Europe",
  "eastern europe": "Eastern Europe",
  "northern europe": "Northern Europe",
  "southern europe": "Southern Europe",
  "sub-saharan africa": "Sub-Saharan Africa",
  "north africa": "North Africa",
  "west africa": "West Africa",
  "east africa": "East Africa",
  kurdistan: "Kurdistan",
  siberia: "Siberia",
  sahara: "the Sahara",
  "the sahara": "the Sahara",
  lapland: "Lapland",
  patagonia: "Patagonia",
};

/** "middle east" → "the Middle East"; null if it is not a known region. */
export function regionName(location: string): string | null {
  return REGIONS[location.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

/** Country names (and common short forms) → ISO alpha-2. */
const COUNTRY_NAMES: Readonly<Record<string, string>> = {
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  iceland: "IS",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  "united kingdom": "GB",
  uk: "GB",
  england: "GB",
  scotland: "GB",
  britain: "GB",
  "great britain": "GB",
  ireland: "IE",
  france: "FR",
  germany: "DE",
  netherlands: "NL",
  holland: "NL",
  belgium: "BE",
  luxembourg: "LU",
  switzerland: "CH",
  austria: "AT",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  greece: "GR",
  poland: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  slovakia: "SK",
  hungary: "HU",
  romania: "RO",
  bulgaria: "BG",
  croatia: "HR",
  slovenia: "SI",
  serbia: "RS",
  ukraine: "UA",
  turkey: "TR",
  russia: "RU",
  "united states": "US",
  usa: "US",
  us: "US",
  canada: "CA",
  mexico: "MX",
  brazil: "BR",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  peru: "PE",
  japan: "JP",
  china: "CN",
  "south korea": "KR",
  korea: "KR",
  india: "IN",
  pakistan: "PK",
  thailand: "TH",
  vietnam: "VN",
  indonesia: "ID",
  philippines: "PH",
  malaysia: "MY",
  singapore: "SG",
  australia: "AU",
  "new zealand": "NZ",
  egypt: "EG",
  morocco: "MA",
  nigeria: "NG",
  kenya: "KE",
  "south africa": "ZA",
  ethiopia: "ET",
  "saudi arabia": "SA",
  "united arab emirates": "AE",
  uae: "AE",
  israel: "IL",
  iran: "IR",
  iraq: "IQ",
  syria: "SY",
  jordan: "JO",
  lebanon: "LB",
};

/**
 * True for a known country or region name ("France", "UK", "the Middle East").
 * Used so a place is never read as a target language ("weather in France").
 */
export function isCountryOrRegion(name: string): boolean {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  return key in COUNTRY_NAMES || key in REGIONS;
}

/**
 * "Paris, France" / "Paris in France" / "Springfield USA" → { place, countryCode }.
 * A place without a country comes back unchanged.
 */
export function splitCountry(location: string): { place: string; countryCode?: string } {
  const words = location.trim().replace(/,/g, " ").split(/\s+/);
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const tail = words.slice(-n).join(" ").toLowerCase();
    const code = COUNTRY_NAMES[tail];
    if (code) {
      const place = words
        .slice(0, -n)
        .join(" ")
        .replace(/\s+in$/i, "")
        .trim();
      if (place) return { place, countryCode: code };
    }
  }
  return { place: location.trim() };
}
