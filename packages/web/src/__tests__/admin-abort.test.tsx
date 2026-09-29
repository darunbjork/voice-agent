import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "../pages/AdminPage.js";

describe("AdminPage abortability (Rule 30)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("aborts in-flight admin requests on unmount", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }),
    );

    const { unmount } = render(<AdminPage onBack={() => undefined} />);
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));
    expect(signals.every((s) => s !== undefined)).toBe(true);

    unmount();
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
  });

  it("passes an AbortSignal on every request", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        return new Promise<Response>(() => undefined);
      }),
    );

    render(<AdminPage onBack={() => undefined} />);
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });
});
