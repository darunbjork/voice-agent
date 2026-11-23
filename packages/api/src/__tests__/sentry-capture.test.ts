// Sentry gets every server error (HTTP 500s and failed WebSocket turns) once,
// and nothing that is the client's fault (4xx). Before, Sentry was only
// initialised: no error was ever reported.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

const { sentry, handleUtteranceMock } = vi.hoisted(() => ({
  sentry: {
    init: vi.fn(),
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    fastifyIntegration: vi.fn((options: unknown) => ({ name: "Fastify", options })),
  },
  handleUtteranceMock: vi.fn(),
}));
vi.mock("@sentry/node", () => sentry);
vi.mock("../modules/agent/agent.service.js", () => ({ handleUtterance: handleUtteranceMock }));

import { buildApp } from "../app.js";
import { env } from "../env.js";
import { initSentry } from "../sentry.js";

const savedDsn = env.SENTRY_DSN;
const FAKE_DSN = "https://public@o0.ingest.sentry.io/0";

describe("Sentry error capture", () => {
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    app = await buildApp();
    app.get("/__boom", async () => {
      throw new Error("boom");
    });
    app.post(
      "/__validated",
      { schema: { body: { type: "object", required: ["x"] } } },
      async () => ({ ok: true }),
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
    env.SENTRY_DSN = savedDsn;
  });

  beforeEach(() => {
    env.SENTRY_DSN = FAKE_DSN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    env.SENTRY_DSN = savedDsn;
  });

  it("init turns off the Fastify integration's own capture so errors are reported once", () => {
    initSentry();
    expect(sentry.init).toHaveBeenCalledTimes(1);
    const options = sentry.fastifyIntegration.mock.calls[0]?.[0] as {
      shouldHandleError: () => boolean;
    };
    expect(options.shouldHandleError()).toBe(false);
  });

  it("an unhandled route error answers 500 and is captured once with its correlation id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__boom",
      headers: { "x-correlation-id": "corr-123" },
    });
    expect(res.statusCode).toBe(500);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = sentry.captureException.mock.calls[0]!;
    expect((err as Error).message).toBe("boom");
    expect(context).toMatchObject({ tags: { correlationId: "corr-123", route: "/__boom" } });
  });

  it("client errors (400 validation) are not captured", async () => {
    const res = await app.inject({ method: "POST", url: "/__validated", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("nothing is sent when SENTRY_DSN is unset", async () => {
    env.SENTRY_DSN = "";
    const res = await app.inject({ method: "GET", url: "/__boom" });
    expect(res.statusCode).toBe(500);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("a failed WebSocket agent turn is captured", async () => {
    handleUtteranceMock.mockRejectedValue(new Error("pipeline exploded"));
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws/audio`, {
        headers: { Origin: "http://localhost:5173" },
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === "session_id") ws.send(JSON.stringify({ type: "text_input", text: "hi" }));
        if (msg.type === "error") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("no error message")), 5000);
    });
    const captured = sentry.captureException.mock.calls.map((c) => (c[0] as Error).message);
    expect(captured).toContain("pipeline exploded");
  });
});
