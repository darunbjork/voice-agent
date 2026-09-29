import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "../pages/AdminPage.js";

describe("AdminPage auth (Rule 21 surface)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends the stored authorization header on every request", async () => {
    const stored = btoa("admin:secret");
    sessionStorage.setItem("voice-agent:admin-auth", stored);
    const fetchMock = vi.fn((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage onBack={() => undefined} />);
    await screen.findByPlaceholderText("Admin password");

    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${stored}`);
    }
  });

  it("turns a 401 into the password prompt without touching state after abort", async () => {
    const fetchMock = vi.fn((_input: unknown, _init?: RequestInit) =>
      Promise.resolve(new Response("{}", { status: 401 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminPage onBack={() => undefined} />);
    const prompt = await screen.findByPlaceholderText("Admin password");
    expect(prompt).toBeTruthy();
    expect(sessionStorage.getItem("voice-agent:admin-auth")).toBeNull();
  });
});
