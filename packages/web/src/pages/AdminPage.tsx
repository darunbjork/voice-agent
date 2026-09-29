import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

type SessionListItem = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  totalTokens: number;
  language: string;
};

type Turn = {
  id: string;
  turnIndex: number;
  userTranscript: string;
  agentReply: string;
  intentType: string | null;
  cardType: string | null;
  sttLatencyMs: number | null;
  llmLatencyMs: number | null;
  ttsLatencyMs: number | null;
  totalLatencyMs: number | null;
};

type SessionDetail = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  totalTokens: number;
  turns: Turn[];
};

type UsageSummary = {
  usage: {
    date: string;
    tokens: number;
    ttsChars: number;
    sttSeconds: number;
  };
  dailyMaxTokens: number;
  usagePercent: number;
  circuits: Array<{ provider: string; state: string; failures: number }>;
};

const API_BASE = import.meta.env.VITE_API_URL ?? "";

const AUTH_STORAGE_KEY = "voice-agent:admin-auth";

function getAuthHeader(): string | null {
  const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  return raw && raw.length > 0 ? `Basic ${raw}` : null;
}

function setAuthHeader(password: string): void {
  const header = btoa(`admin:${password}`);
  sessionStorage.setItem(AUTH_STORAGE_KEY, header);
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const auth = getAuthHeader();
  const res = await fetch(`${API_BASE}${url}`, {
    credentials: "include",
    headers: auth ? { authorization: auth } : undefined,
    signal,
  });
  if (res.status === 401) throw new Error("unauthorized");
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export type AdminPageProps = {
  onBack: () => void;
};

export function AdminPage({ onBack }: AdminPageProps) {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<SessionDetail | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [passwordInput, setPasswordInput] = useState("");
  const [needPassword, setNeedPassword] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  // A newer request supersedes an older one; unmount aborts whatever is
  // still in flight (Rule 30).
  const nextController = useCallback((): AbortController => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);

  const load = useCallback(async () => {
    const controller = nextController();
    const { signal } = controller;
    setLoading(true);
    setError(null);
    try {
      const [listJson, usageJson] = await Promise.all([
        fetchJson<{ sessions: SessionListItem[]; total: number }>(
          "/api/v1/admin/sessions?limit=30",
          signal,
        ),
        fetchJson<UsageSummary>("/api/v1/admin/usage", signal),
      ]);
      if (signal.aborted) return;
      setSessions(listJson.sessions);
      setTotal(listJson.total);
      setUsage(usageJson);
      setNeedPassword(false);
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof Error && err.message === "unauthorized") {
        setNeedPassword(true);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load admin data");
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [nextController]);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const openSession = async (id: string): Promise<void> => {
    const controller = nextController();
    const { signal } = controller;
    setError(null);
    try {
      const json = await fetchJson<SessionDetail>(`/api/v1/admin/sessions/${id}`, signal);
      if (signal.aborted) return;
      setSelected(json);
    } catch (err) {
      if (signal.aborted) return;
      setError(err instanceof Error ? err.message : "Failed to load session");
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--void)",
        color: "var(--text)",
        padding: "2rem 1.25rem 3rem",
        maxWidth: 720,
        margin: "0 auto",
        fontFamily: "var(--font-body)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "1.5rem",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: 24,
              fontWeight: 700,
            }}
          >
            Admin
          </h1>
          <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 13 }}>
            Sessions · turns · daily usage
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={() => void load()}
            className="btn-ghost"
            style={{ padding: "0.45rem 0.9rem" }}
          >
            Refresh
          </button>
          <button type="button" onClick={onBack} style={primaryBtn}>
            Back to agent
          </button>
        </div>
      </header>

      {error && (
        <div
          style={{
            background: "rgba(239, 68, 68, 0.12)",
            border: "1px solid var(--error)",
            borderRadius: "var(--radius-md)",
            padding: "0.75rem 1rem",
            marginBottom: "1rem",
            fontSize: 13,
            color: "var(--error)",
          }}
        >
          {error}
        </div>
      )}
      {needPassword && (
        <div style={{ ...panelStyle, marginBottom: "1rem" }}>
          <h2 style={sectionTitle}>Admin login</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!passwordInput) return;
              setAuthHeader(passwordInput);
              setPasswordInput("");
              void load();
            }}
            style={{ display: "flex", gap: 8 }}
          >
            <input
              type="password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              placeholder="Admin password"
              autoComplete="current-password"
              style={{
                flex: 1,
                padding: "0.6rem 0.85rem",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border)",
                background: "var(--surface-2)",
                color: "var(--text)",
                fontSize: 14,
              }}
            />
            <button type="submit" style={primaryBtn}>
              Sign in
            </button>
          </form>
        </div>
      )}
      <section style={panelStyle}>
        <h2 style={sectionTitle}>Today's usage</h2>
        {usage ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 12,
            }}
          >
            <Metric
              label="Est. tokens"
              value={`${usage.usage.tokens} / ${usage.dailyMaxTokens}`}
              sub={`${usage.usagePercent}%`}
            />
            <Metric label="TTS chars" value={String(usage.usage.ttsChars)} />
            <Metric label="STT seconds" value={String(usage.usage.sttSeconds)} />
          </div>
        ) : (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            {loading ? "Loading…" : "No usage data"}
          </p>
        )}
        {usage && usage.circuits.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>Circuits</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {usage.circuits.map((c) => (
                <span
                  key={c.provider}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--surface-2)",
                  }}
                >
                  {c.provider}: {c.state}
                  {c.failures > 0 ? ` (${c.failures})` : ""}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section style={{ ...panelStyle, marginTop: "1rem" }}>
        <h2 style={sectionTitle}>
          Sessions <span style={{ color: "var(--muted)", fontWeight: 400 }}>({total})</span>
        </h2>

        {selected ? (
          <div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="btn-ghost"
              style={{ padding: "0.45rem 0.9rem", marginBottom: 12 }}
            >
              ← All sessions
            </button>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                color: "var(--muted)",
                marginBottom: 12,
              }}
            >
              {selected.id}
              <br />
              {new Date(selected.startedAt).toLocaleString()} · {selected.turnCount} turns ·{" "}
              {selected.totalTokens} est. tokens
            </div>
            {selected.turns.length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 13 }}>No turns</p>
            )}
            {selected.turns.map((t) => (
              <div
                key={t.id}
                style={{
                  borderTop: "1px solid var(--border)",
                  padding: "0.75rem 0",
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--iris-soft)",
                    marginBottom: 4,
                  }}
                >
                  #{t.turnIndex} · {t.intentType ?? "—"} ·{" "}
                  {t.totalLatencyMs != null ? `${t.totalLatencyMs} ms` : "—"}
                </div>
                <div style={{ marginBottom: 4 }}>
                  <strong style={{ color: "var(--muted)" }}>User: </strong>
                  {t.userTranscript}
                </div>
                <div>
                  <strong style={{ color: "var(--muted)" }}>Agent: </strong>
                  {t.agentReply}
                </div>
              </div>
            ))}
          </div>
        ) : loading ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</p>
        ) : sessions.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 13 }}>
            No sessions yet — run a voice or text turn first.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {sessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => void openSession(s.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "0.65rem 0.85rem",
                    marginBottom: 8,
                    color: "var(--text)",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--iris-soft)",
                    }}
                  >
                    {s.id.slice(0, 12)}…
                  </div>
                  <div style={{ fontSize: 13, marginTop: 2 }}>
                    {new Date(s.startedAt).toLocaleString()}
                    {s.endedAt ? " · ended" : " · active"}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--muted)",
                      marginTop: 2,
                    }}
                  >
                    {s.turnCount} turns · {s.totalTokens} est. tokens · {s.language}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--muted)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--ember)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: "var(--glass-bg)",
  backdropFilter: "var(--blur)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-lg)",
  padding: "1.25rem",
  boxShadow: "var(--shadow-glass)",
};

const sectionTitle: CSSProperties = {
  margin: "0 0 0.85rem",
  fontFamily: "var(--font-display)",
  fontSize: 16,
  fontWeight: 700,
};

const primaryBtn: CSSProperties = {
  background: "var(--iris)",
  color: "#fff",
  border: "none",
  borderRadius: "var(--radius-sm)",
  padding: "0.45rem 0.9rem",
  fontWeight: 600,
  fontSize: 13,
  cursor: "pointer",
};
