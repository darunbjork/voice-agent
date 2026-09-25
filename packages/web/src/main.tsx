import {
  SHARED_TYPES_VERSION,
  type IntentType,
  type ResponseCard,
} from "@voice-agent/shared-types";

const exampleIntent: IntentType = "weather";

const exampleCard: ResponseCard = {
  type: "weather",
  icon: "⛅",
  temp: "22°C",
  desc: "Partly cloudy",
  humidity: "48%",
  wind: "12 km/h",
  location: "Lisbon",
};

const root = document.getElementById("root");
if (root) {
  root.innerHTML = `
    <div style="font-family: system-ui; padding: 2rem; background: #0a0a0f; color: #e2e8f0; min-height: 100vh;">
      <h1>Voice Agent — Day 2</h1>
      <p>shared-types version: <code>${SHARED_TYPES_VERSION}</code></p>
      <p>Example intent: <code>${exampleIntent}</code></p>
      <p>Example card: <code>${exampleCard.type}</code> — ${exampleCard.icon} ${exampleCard.temp}, ${exampleCard.desc} in ${exampleCard.location}</p>
      <p>All audio, agent, session and card types are now locked.</p>
    </div>
  `;
}
