// C8 — release_command failed with Prisma P1001 when the Fly Postgres machine
// was asleep: it wakes on the first connection but takes more than 5 s.
// scripts/release.sh now waits for the DB (SELECT 1, retried with backoff for
// up to ~60 s) before `prisma migrate deploy`. The wait logic gets an injected
// check, sleep and clock, so these tests take no real time.
import { describe, it, expect } from "vitest";
import { waitForDb, DbNotReadyError, selectOne, errorText } from "../scripts/wait-for-db.js";

/** Fake clock: sleep() moves time forward instantly. */
function fakeTime() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

/** A check that fails `failures` times (like a sleeping DB), then succeeds. */
function wakesAfter(failures: number) {
  let calls = 0;
  return {
    calls: () => calls,
    check: async () => {
      calls += 1;
      if (calls <= failures) throw new Error(`P1001: Can't reach database server (call ${calls})`);
    },
  };
}

describe("waitForDb", () => {
  it("returns at once when the DB is up", async () => {
    const time = fakeTime();
    const logs: string[] = [];
    const db = wakesAfter(0);
    const result = await waitForDb({ ...time, check: db.check, log: (m) => logs.push(m) });
    expect(result.attempts).toBe(1);
    expect(time.sleeps).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/attempt 1.*ready/i);
  });

  it("retries a sleeping DB with backoff and logs every attempt", async () => {
    const time = fakeTime();
    const logs: string[] = [];
    const db = wakesAfter(4);
    const result = await waitForDb({ ...time, check: db.check, log: (m) => logs.push(m) });

    expect(result.attempts).toBe(5);
    expect(db.calls()).toBe(5);
    // 1 s, 2 s, 4 s, 8 s: doubling backoff.
    expect(time.sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(logs).toHaveLength(5);
    expect(logs[0]).toMatch(/attempt 1.*not reachable.*P1001.*retrying in 1000 ms/i);
    expect(logs[4]).toMatch(/attempt 5.*ready/i);
  });

  it("caps the delay and gives up after about 60 s with a clear error", async () => {
    const time = fakeTime();
    const logs: string[] = [];
    const db = wakesAfter(Infinity);

    const err = await waitForDb({ ...time, check: db.check, log: (m) => logs.push(m) }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DbNotReadyError);
    expect((err as Error).message).toMatch(/not reachable after \d+ attempts in 60 s/i);
    expect((err as Error).message).toMatch(/P1001/); // the last cause is kept
    expect(Math.max(...time.sleeps)).toBe(8000); // capped
    // Never sleeps past the deadline.
    expect(time.now()).toBeLessThanOrEqual(60_000);
    expect(time.sleeps.reduce((a, b) => a + b, 0)).toBe(time.now());
    expect(logs.length).toBe(db.calls());
  });

  it("a check that hangs counts as a failed attempt (per-attempt timeout)", async () => {
    const time = fakeTime();
    let calls = 0;
    const check = async () => {
      calls += 1;
      if (calls === 1) throw new Error("attempt timed out after 5000 ms");
    };
    const result = await waitForDb({ ...time, check, log: () => undefined });
    expect(result.attempts).toBe(2);
  });
});

describe("selectOne (the real check)", () => {
  it("runs SELECT 1 against the database in DATABASE_URL", async () => {
    await expect(selectOne(process.env.DATABASE_URL ?? "", 5000)).resolves.toBeUndefined();
  });

  it("fails for a database that does not answer", async () => {
    await expect(
      selectOne("postgresql://nobody:nothing@127.0.0.1:1/none?connect_timeout=1", 3000),
    ).rejects.toThrow();
  });
});

describe("errorText", () => {
  it("logs Prisma's real cause with its code, not the 'Invalid invocation' header", () => {
    const err = Object.assign(
      new Error(
        "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach database server at `db:5432`",
      ),
      { code: "P1001" },
    );
    expect(errorText(err)).toBe("P1001: Can't reach database server at `db:5432`");
  });
});
