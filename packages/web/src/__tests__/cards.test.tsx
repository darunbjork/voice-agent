import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ResponseCard } from "@voice-agent/shared-types";
import { ResponseCardView } from "../components/cards/ResponseCardView.js";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

afterEach(() => {
  cleanup();
});

const cards: Array<{ card: ResponseCard; assert: () => void }> = [
  {
    card: {
      type: "weather",
      icon: "⛅",
      temp: "18°C",
      desc: "Breezy with a chance of late showers",
      humidity: "74%",
      wind: "18 km/h SW",
      location: "Lisbon, Portugal",
    },
    assert: () => {
      expect(screen.getByText("Weather · Lisbon, Portugal")).toBeTruthy();
      expect(screen.getByText("18°C")).toBeTruthy();
      expect(screen.getByText("Breezy with a chance of late showers")).toBeTruthy();
    },
  },
  {
    card: {
      type: "reminder",
      note: "Call the accountant before the quarterly filing deadline",
      time: "tomorrow at 09:30",
    },
    assert: () => {
      expect(
        screen.getByText("Call the accountant before the quarterly filing deadline"),
      ).toBeTruthy();
      expect(screen.getByText("tomorrow at 09:30")).toBeTruthy();
    },
  },
  {
    card: {
      type: "translate",
      original: "¿Dónde está la estación de tren más cercana?",
      translated: "Where is the nearest train station?",
      fromLang: "Spanish",
      toLang: "English",
    },
    assert: () => {
      expect(screen.getByText("Where is the nearest train station?")).toBeTruthy();
      expect(screen.getByText(/Spanish/)).toBeTruthy();
    },
  },
  {
    card: {
      type: "summary",
      points: [
        "Latency improved 18% after the STT batching change",
        "Two flaky session tests still need attention",
        "Release is blocked on the migration rollback rehearsal",
      ],
      source: "standup notes, 29 Sep",
    },
    assert: () => {
      expect(screen.getByText("Latency improved 18% after the STT batching change")).toBeTruthy();
      expect(screen.getByText(/Source: standup notes, 29 Sep/)).toBeTruthy();
    },
  },
  {
    card: {
      type: "help",
      commands: [
        { name: "/weather", description: "Forecast for a city" },
        { name: "/remind", description: "Set a timed reminder" },
      ],
    },
    assert: () => {
      expect(screen.getByText("/weather")).toBeTruthy();
      expect(screen.getByText("Set a timed reminder")).toBeTruthy();
    },
  },
];

describe("ResponseCardView", () => {
  for (const { card, assert } of cards) {
    it(`renders the ${card.type} card with its content`, () => {
      render(<ResponseCardView card={card} />);
      assert();
    });
  }
});
