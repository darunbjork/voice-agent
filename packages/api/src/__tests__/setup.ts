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

function forecastResponse(): Response {
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
  if (url.includes("api.open-meteo.com")) return forecastResponse();
  return realFetch(input, init);
};
