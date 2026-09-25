import {
  SHARED_TYPES_VERSION,
  type HealthStatus,
  type IntentType,
  type ClientAudioMessage,
} from "@voice-agent/shared-types";

const status: HealthStatus = "ok";
const exampleIntent: IntentType = "help";

const exampleMessage: ClientAudioMessage = {
  type: "text_input",
  text: "What can you do?",
};

console.log(`[api] shared-types version: ${SHARED_TYPES_VERSION}`);
console.log(`[api] health status: ${status}`);
console.log(`[api] example intent: ${exampleIntent}`);
console.log(`[api] example client message type: ${exampleMessage.type}`);
console.log("[api] shared types ready. Waiting for Fastify bootstrap.");
