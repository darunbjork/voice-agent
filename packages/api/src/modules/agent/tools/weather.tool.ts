import type { WeatherCard } from "@voice-agent/shared-types";

export type WeatherToolInput = {
  userText: string;
  slots: Record<string, string>;
};

export type WeatherToolResult = {
  card: WeatherCard;
  replyHint: string;
};

export async function weatherTool(input: WeatherToolInput): Promise<WeatherToolResult> {
  const location = input.slots.location?.trim() || extractLocation(input.userText) || "Stockholm";

  const card: WeatherCard = {
    type: "weather",
    icon: "☀️",
    temp: "22°C",
    desc: "Partly cloudy",
    humidity: "55%",
    wind: "12 km/h",
    location,
  };

  return {
    card,
    replyHint: `It is ${card.temp} and ${card.desc.toLowerCase()} in ${location}.`,
  };
}

function extractLocation(text: string): string | null {
  const m = text.match(/\b(?:in|for|at)\s+([A-Za-z][A-Za-z\s-]{1,40})(?:\?|$)/i);
  return m?.[1]?.trim() ?? null;
}
