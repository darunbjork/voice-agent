import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";

describe("GET /docs/json", () => {
  let app: FastifyInstance | undefined;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("serves a valid OpenAPI document with the admin security scheme", async () => {
    if (!app) throw new Error("app not initialized");
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    expect(response.statusCode).toBe(200);

    const spec = response.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.components.securitySchemes.basicAuth).toMatchObject({
      type: "http",
      scheme: "basic",
    });

    const adminUsage = spec.paths["/api/v1/admin/usage"]?.get;
    expect(adminUsage?.security).toEqual([{ basicAuth: [] }]);
  });
});
