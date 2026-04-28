"use client";

import { useEffect, useState } from "react";

const AGENT_API_URL = process.env.NEXT_PUBLIC_AGENT_API_URL || "http://localhost:8000";

export default function HistoryPage() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    fetchSessions();
  }, []);

  async function fetchSessions() {
    try {
      setLoading(true);
      const res = await fetch(`${AGENT_API_URL}/v1/sessions?limit=50`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold">Call History</h1>
        <button
          onClick={fetchSessions}
          className="text-xs px-3 py-1.5 rounded border border-border hover:border-accent hover:text-accent transition-colors"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="text-text-dim text-sm text-center py-12">Loading…</div>
      )}

      {error && (
        <div className="text-red-400 text-sm bg-red-900/10 border border-red-900/30 rounded-lg p-4 mb-4">
          Failed to load call history: {error}
          <div className="text-xs text-text-dim mt-1">
            Make sure NEXT_PUBLIC_AGENT_API_URL is set correctly and agent-api is running.
          </div>
        </div>
      )}

      {!loading && !error && sessions.length === 0 && (
        <div className="text-text-dim text-sm text-center py-12">
          No call history yet. Make some test calls first.
        </div>
      )}

      <div className="space-y-2">
        {sessions.map((s) => (
          <div key={s.call_uuid}>
            <button
              onClick={() =>
                setSelected(selected === s.call_uuid ? null : s.call_uuid)
              }
              className={`w-full text-left p-4 rounded-lg border transition-colors ${
                selected === s.call_uuid
                  ? "border-accent bg-accent/5"
                  : "border-border bg-surface hover:border-text-dim"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span className="font-mono text-xs text-text-muted">
                    {s.caller_phone || "unknown"}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      s.outcome === "completed"
                        ? "bg-green-900/20 text-green-400"
                        : s.outcome === "transferred"
                        ? "bg-yellow-900/20 text-yellow-400"
                        : "bg-text-dim/20 text-text-dim"
                    }`}
                  >
                    {s.outcome || "unknown"}
                  </span>
                </div>
                <div className="text-xs text-text-dim">
                  {s.started_at
                    ? new Date(s.started_at).toLocaleString()
                    : "unknown time"}
                </div>
              </div>
            </button>

            {/* Expanded transcript */}
            {selected === s.call_uuid && s.transcript && (
              <div className="ml-4 mt-2 p-4 bg-surface2 border border-border rounded-lg mb-2">
                <div className="text-xs text-text-dim mb-2 font-semibold">
                  Transcript
                </div>
                <div className="space-y-2 text-sm">
                  {s.transcript.split("\n").map((line, i) => {
                    const isUser = line.startsWith("user:");
                    const isAssistant = line.startsWith("assistant:");
                    const text = line.replace(/^(user|assistant):\s*/, "");
                    if (!text.trim()) return null;
                    return (
                      <div
                        key={i}
                        className={`flex ${isUser ? "justify-start" : "justify-end"}`}
                      >
                        <div
                          className={`max-w-[80%] px-3 py-2 rounded-lg ${
                            isAssistant
                              ? "bg-accent/10 border border-accent/20"
                              : "bg-surface border border-border"
                          }`}
                        >
                          <span className="text-[10px] text-text-dim">
                            {isAssistant ? "🤖 AI" : "📞 Caller"}
                          </span>
                          <div className="mt-0.5">{text}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Entities */}
                {s.entities && Object.keys(s.entities).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="text-xs text-text-dim mb-1">
                      Extracted Entities
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(s.entities)
                        .filter(([, v]) => v != null && v !== "" && (!Array.isArray(v) || v.length > 0))
                        .map(([k, v]) => (
                          <span
                            key={k}
                            className="text-[11px] bg-accent-4/10 text-accent-4 px-2 py-0.5 rounded"
                          >
                            {k}: {Array.isArray(v) ? v.join(", ") : String(v)}
                          </span>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
