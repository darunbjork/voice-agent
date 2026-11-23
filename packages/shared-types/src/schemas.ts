// Runtime validation for messages a client sends on /api/ws/audio.
// Exported from "@voice-agent/shared-types/schemas" (not the main entry), so
// the web bundle, which only needs the types, does not pull in zod.
import { z } from "zod";
import type { ClientAudioMessage } from "./audio.types.js";

/** Same cap as the HTTP text route. */
export const TEXT_INPUT_MAX_CHARS = 500;

/**
 * JSON control messages. Audio is never JSON: it arrives as binary PCM frames,
 * so `audio_chunk` is not accepted here.
 */
export const ClientControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text_input"),
      text: z
        .string()
        .max(TEXT_INPUT_MAX_CHARS, { message: "text_too_long" })
        .refine((t) => t.trim().length > 0, { message: "text_empty" }),
    })
    .strict(),
  z.object({ type: z.literal("barge_in") }).strict(),
  z.object({ type: z.literal("session_end") }).strict(),
]);

export type ClientControlMessage = z.infer<typeof ClientControlMessageSchema>;

// Compile-time check: every validated message is a valid ClientAudioMessage.
const _isClientAudioMessage: (m: ClientControlMessage) => ClientAudioMessage = (m) => m;
void _isClientAudioMessage;

export type ParsedClientMessage =
  | { ok: true; message: ClientControlMessage }
  | { ok: false; code: "invalid_message" | "text_too_long"; message: string };

/** Parses one text frame. Never throws. */
export function parseClientControlMessage(raw: string): ParsedClientMessage {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: "invalid_message", message: "Could not parse client message" };
  }
  const parsed = ClientControlMessageSchema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  if (parsed.error.issues.some((i) => i.message === "text_too_long")) {
    return {
      ok: false,
      code: "text_too_long",
      message: `Text input is limited to ${TEXT_INPUT_MAX_CHARS} characters.`,
    };
  }
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
  return {
    ok: false,
    code: "invalid_message",
    message: `Invalid client message${where}: ${issue?.message ?? "unknown"}`,
  };
}
