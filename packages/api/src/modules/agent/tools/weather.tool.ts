import type { WeatherCard } from "@voice-agent/shared-types";
import {
  CAPITALS,
  MAX_FORECAST_DAYS,
  cleanLocation,
  extractWeatherLocation,
  parseForecastDay,
  regionName,
  splitCountry,
} from "../location.js";
import { ASSISTANT_TIME_ZONE } from "../gemini.tools.js";

export type WeatherToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type WeatherToolResult = {
  /** Null when we need the user to name a city first. */
  card: WeatherCard | null;
  replyHint: string;
  /** The reply asks "which city?": the next short answer completes this request. */
  needsCity?: boolean;
};

const FETCH_TIMEOUT_MS = 4000;

const capitalise = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** Weekday (0 = Sunday) in the assistant's time zone. */
function weekdayNow(now: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: ASSISTANT_TIME_ZONE,
    weekday: "long",
  }).format(now);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].indexOf(
    name,
  );
}

export async function weatherTool(
  input: WeatherToolInput,
  now: Date = new Date(),
): Promise<WeatherToolResult> {
  const location =
    cleanLocation(input.slots.location ?? "") ||
    extractWeatherLocation(input.userText) ||
    "Stockholm";

  // Continents and regions have no single weather — and the geocoder matches
  // them to villages elsewhere ("Middle East" → a hamlet in the US).
  const region = regionName(location);
  if (region) {
    return {
      card: null,
      replyHint: `${capitalise(region)} is a big area. Which city in ${region} would you like the weather for?`,
      needsCity: true,
    };
  }

  const day = parseForecastDay(input.userText, weekdayNow(now));
  if (day.kind === "unsupported") {
    return {
      card: null,
      replyHint: `I can only give the current weather or a forecast for the next ${MAX_FORECAST_DAYS} days, not ${day.phrase}. Which day would you like?`,
    };
  }

  const { place, countryCode } = splitCountry(location);

  try {
    let geo = await geocode(place, countryCode);
    if (!geo) {
      return {
        card: unavailableCard(location),
        replyHint: countryCode
          ? `I could not find a place called ${place} in that country.`
          : `I could not find a place called ${location}.`,
      };
    }
    // Never accept a match in a different country than the one the user named.
    if (countryCode && geo.countryCode !== countryCode) {
      return {
        card: null,
        replyHint: `I could not find ${place} in that country. Which city did you mean?`,
        needsCity: true,
      };
    }
    if (geo.isRegion) {
      return {
        card: null,
        replyHint: `${geo.name} is a big area. Which city there would you like the weather for?`,
        needsCity: true,
      };
    }

    // A whole country has no single weather: use its capital, or ask.
    let note = "";
    if (geo.isCountry) {
      const capital = CAPITALS[geo.countryCode];
      const capitalGeo = capital ? await geocode(capital, geo.countryCode) : null;
      if (!capitalGeo) {
        return {
          card: null,
          replyHint: `${geo.name} is a big place. Which city in ${geo.name} would you like the weather for?`,
          needsCity: true,
        };
      }
      note = `For ${geo.name} I am using the capital, ${capitalGeo.name}. `;
      geo = capitalGeo;
    }

    if (day.kind === "day") {
      const { card, precipitation, summary } = await fetchDailyForecast(geo, day.offset, day.label);
      const rain = precipitation !== null ? `, ${precipitation}% chance of rain` : "";
      return {
        card,
        replyHint: `${note}${capitalise(day.label)} in ${card.location}: ${summary.toLowerCase()}, ${card.temp}${rain}.`,
      };
    }

    const card = await fetchCurrentWeather(geo);
    return {
      card,
      replyHint: `${note}It is ${card.temp} and ${card.desc.toLowerCase()} in ${card.location}.`,
    };
  } catch {
    // No made-up numbers: Open-Meteo is the only source of weather data.
    return {
      card: null,
      replyHint: `I could not reach the weather service for ${location} right now. Please try again in a moment.`,
    };
  }
}

function unavailableCard(location: string): WeatherCard {
  return {
    type: "weather",
    icon: "⚠️",
    temp: "—",
    desc: "Data unavailable",
    humidity: "—",
    wind: "—",
    location,
  };
}

type GeocodeResult = {
  name: string;
  country: string;
  countryCode: string;
  /** GeoNames PCL* feature (a country, not a city). */
  isCountry: boolean;
  /** GeoNames continent / region / area feature. */
  isRegion: boolean;
  latitude: number;
  longitude: number;
};

async function geocode(query: string, countryCode?: string): Promise<GeocodeResult | null> {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search" +
    `?name=${encodeURIComponent(query)}&count=1&language=en&format=json` +
    (countryCode ? `&countryCode=${countryCode}` : "");
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{
      name: string;
      country?: string;
      country_code?: string;
      feature_code?: string;
      latitude: number;
      longitude: number;
    }>;
  };
  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    name: hit.name,
    country: hit.country ?? "",
    countryCode: (hit.country_code ?? "").toUpperCase(),
    isCountry: (hit.feature_code ?? "").startsWith("PCL"),
    isRegion: ["CONT", "RGN", "RGNE", "AREA", "ZN"].includes(hit.feature_code ?? ""),
    latitude: hit.latitude,
    longitude: hit.longitude,
  };
}

async function fetchCurrentWeather(geo: GeocodeResult): Promise<WeatherCard> {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code";
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo forecast ${res.status}`);
  const data = (await res.json()) as {
    current?: {
      temperature_2m: number;
      relative_humidity_2m: number;
      wind_speed_10m: number;
      weather_code: number;
    };
  };
  const current = data.current;
  if (!current) throw new Error("Open-Meteo response missing current block");

  const { icon, desc } = mapWeatherCode(current.weather_code);
  return {
    type: "weather",
    icon,
    temp: `${Math.round(current.temperature_2m)}°C`,
    desc,
    humidity: `${Math.round(current.relative_humidity_2m)}%`,
    wind: `${Math.round(current.wind_speed_10m)} km/h`,
    location: geo.country ? `${geo.name}, ${geo.country}` : geo.name,
  };
}

/** Daily forecast for `offset` days from today (0–6), in the place's own time zone. */
async function fetchDailyForecast(
  geo: GeocodeResult,
  offset: number,
  label: string,
): Promise<{ card: WeatherCard; precipitation: number | null; summary: string }> {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max," +
    `wind_speed_10m_max,relative_humidity_2m_mean&timezone=auto&forecast_days=${MAX_FORECAST_DAYS}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo forecast ${res.status}`);
  const data = (await res.json()) as {
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: Array<number | null>;
      wind_speed_10m_max?: number[];
      relative_humidity_2m_mean?: Array<number | null>;
    };
  };
  const d = data.daily;
  const code = d?.weather_code?.[offset];
  const max = d?.temperature_2m_max?.[offset];
  const min = d?.temperature_2m_min?.[offset];
  if (code === undefined || max === undefined || min === undefined) {
    throw new Error("Open-Meteo response missing daily data");
  }
  const { icon, desc } = mapWeatherCode(code);
  const humidity = d?.relative_humidity_2m_mean?.[offset];
  const wind = d?.wind_speed_10m_max?.[offset];
  const lo = Math.round(min);
  const hi = Math.round(max);
  return {
    card: {
      type: "weather",
      icon,
      temp: lo === hi ? `${hi}°C` : `${lo} to ${hi}°C`,
      desc: `${desc} (${label})`,
      humidity: humidity != null ? `${Math.round(humidity)}%` : "—",
      wind: wind !== undefined ? `up to ${Math.round(wind)} km/h` : "—",
      location: geo.country ? `${geo.name}, ${geo.country}` : geo.name,
    },
    precipitation: d?.precipitation_probability_max?.[offset] ?? null,
    summary: desc,
  };
}

/** WMO weather interpretation codes → emoji + human description. */
export function mapWeatherCode(code: number): { icon: string; desc: string } {
  if (code === 0) return { icon: "☀️", desc: "Clear sky" };
  if (code === 1) return { icon: "🌤️", desc: "Mainly clear" };
  if (code === 2) return { icon: "⛅", desc: "Partly cloudy" };
  if (code === 3) return { icon: "☁️", desc: "Overcast" };
  if (code === 45 || code === 48) return { icon: "🌫️", desc: "Fog" };
  if (code >= 51 && code <= 57) return { icon: "🌦️", desc: "Drizzle" };
  if (code >= 61 && code <= 67) return { icon: "🌧️", desc: "Rain" };
  if (code >= 71 && code <= 77) return { icon: "❄️", desc: "Snow" };
  if (code >= 80 && code <= 82) return { icon: "🌦️", desc: "Rain showers" };
  if (code === 85 || code === 86) return { icon: "❄️", desc: "Snow showers" };
  if (code === 95) return { icon: "⛈️", desc: "Thunderstorm" };
  if (code === 96 || code === 99) return { icon: "⛈️", desc: "Thunderstorm with hail" };
  return { icon: "🌡️", desc: "Unknown" };
}
