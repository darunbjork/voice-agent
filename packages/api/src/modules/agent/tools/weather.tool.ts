import type { WeatherCard } from "@voice-agent/shared-types";

export type WeatherToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type WeatherToolResult = {
  card: WeatherCard;
  replyHint: string;
};

const FETCH_TIMEOUT_MS = 4000;

export async function weatherTool(input: WeatherToolInput): Promise<WeatherToolResult> {
  const location = input.slots.location?.trim() || extractLocation(input.userText) || "Stockholm";

  try {
    const geo = await geocode(location);
    if (!geo) {
      return {
        card: unavailableCard(location),
        replyHint: `I could not find a place called ${location}.`,
      };
    }
    const card = await fetchCurrentWeather(geo);
    return {
      card,
      replyHint: `It is ${card.temp} and ${card.desc.toLowerCase()} in ${card.location}.`,
    };
  } catch {
    const card = offlineCard(location);
    return {
      card,
      replyHint: `I could not reach the weather service for ${location} right now, so this is demo data: it is ${card.temp} and ${card.desc.toLowerCase()}.`,
    };
  }
}

/**
 * Open-Meteo is free and unmetered, so weather never runs behind VOICE_MOCK.
 * This fixture exists only for the case where the network call itself fails.
 */
function offlineCard(location: string): WeatherCard {
  return {
    type: "weather",
    icon: "☀️",
    temp: "22°C",
    desc: "Partly cloudy (demo data)",
    humidity: "55%",
    wind: "12 km/h",
    location,
  };
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
  latitude: number;
  longitude: number;
};

async function geocode(query: string): Promise<GeocodeResult | null> {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search" +
    `?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo geocoding ${res.status}`);
  const data = (await res.json()) as {
    results?: Array<{
      name: string;
      country?: string;
      latitude: number;
      longitude: number;
    }>;
  };
  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    name: hit.name,
    country: hit.country ?? "",
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

function extractLocation(text: string): string | null {
  const m = text.match(/\b(?:in|for|at)\s+([A-Za-z][A-Za-z\s-]{1,40})(?:\?|$)/i);
  return m?.[1]?.trim() ?? null;
}
