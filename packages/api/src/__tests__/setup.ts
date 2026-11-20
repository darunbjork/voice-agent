/**
 * Open-Meteo (geocoding + forecast) is free, unmetered and used by the weather
 * tool in every mode — including VOICE_MOCK=true. Tests must not depend on it,
 * so the two Open-Meteo endpoints are answered locally and everything else is
 * handed back to the real fetch.
 */
const realFetch = globalThis.fetch.bind(globalThis);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function geocodeResponse(url: string): Response {
  const query = new URL(url).searchParams.get("name") ?? "Stockholm";
  return jsonResponse({
    results: [{ name: query, country: "", latitude: 59.33, longitude: 18.06 }],
  });
}

function forecastResponse(url: string): Response {
  if (url.includes("daily=")) {
    // 7-day daily forecast: day i has max 10+i °C, min 2+i °C.
    const days = Array.from({ length: 7 }, (_, i) => i);
    return jsonResponse({
      daily: {
        weather_code: days.map(() => 61),
        temperature_2m_max: days.map((i) => 10 + i),
        temperature_2m_min: days.map((i) => 2 + i),
        precipitation_probability_max: days.map((i) => 40 + i),
        wind_speed_10m_max: days.map(() => 20),
        relative_humidity_2m_mean: days.map(() => 80),
      },
    });
  }
  return jsonResponse({
    current: {
      temperature_2m: 21.6,
      relative_humidity_2m: 61,
      wind_speed_10m: 14.2,
      weather_code: 3,
    },
  });
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.includes("geocoding-api.open-meteo.com")) return geocodeResponse(url);
  if (url.includes("api.open-meteo.com")) return forecastResponse(url);
  return realFetch(input, init);
};
