"use client";

import { useEffect, useState, useRef } from "react";
import { getSocket } from "../lib/socket";

export default function ActiveCallsPage() {
  const [calls, setCalls] = useState({});
  const [selectedCall, setSelectedCall] = useState(null);
  const [connected, setConnected] = useState(false);
  const transcriptEndRef = useRef(null);

  useEffect(() => {
    const socket = getSocket();

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));

    socket.on("call_started", (data) => {
      setCalls((prev) => ({
        ...prev,
        [data.call_uuid]: {
          callUuid: data.call_uuid,
          callerPhone: data.caller_phone_masked || "unknown",
          startedAt: data.started_at || new Date().toISOString(),
          status: "active",
          intent: null,
          transcripts: [],
          partial: "",
          turns: 0,
        },
      }));
    });

    socket.on("transcript_partial", (data) => {
      setCalls((prev) => {
        const call = prev[data.call_uuid];
        if (!call) return prev;
        return { ...prev, [data.call_uuid]: { ...call, partial: data.text } };
      });
    });

    socket.on("transcript_final", (data) => {
      setCalls((prev) => {
        const call = prev[data.call_uuid];
        if (!call) return prev;
        return {
          ...prev,
          [data.call_uuid]: {
            ...call,
            partial: "",
            transcripts: [
              ...call.transcripts,
              { role: data.role, text: data.text, ts: data.ts },
            ],
            turns: data.role === "user" ? call.turns + 1 : call.turns,
          },
        };
      });
    });

    socket.on("intent_classified", (data) => {
      setCalls((prev) => {
        const call = prev[data.call_uuid];
        if (!call) return prev;
        return {
          ...prev,
          [data.call_uuid]: { ...call, intent: data.intent },
        };
      });
    });

    socket.on("agent_response", (data) => {
      setCalls((prev) => {
        const call = prev[data.call_uuid];
        if (!call) return prev;
        return {
          ...prev,
          [data.call_uuid]: {
            ...call,
            lastAction: data.action,
            lastLatency: data.latency_ms,
            vehicleCount: data.vehicle_count,
          },
        };
      });
    });

    socket.on("call_ended", (data) => {
      setCalls((prev) => {
        const call = prev[data.call_uuid];
        if (!call) return prev;
        return {
          ...prev,
          [data.call_uuid]: {
            ...call,
            status: "ended",
            endedAt: data.ended_at,
            outcome: data.outcome,
            durationMs: data.duration_ms,
          },
        };
      });

      // Remove ended calls after 30 seconds
      setTimeout(() => {
        setCalls((prev) => {
          const next = { ...prev };
          delete next[data.call_uuid];
          return next;
        });
      }, 30000);
    });

    return () => {
      socket.off("call_started");
      socket.off("transcript_partial");
      socket.off("transcript_final");
      socket.off("intent_classified");
      socket.off("agent_response");
      socket.off("call_ended");
    };
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [calls, selectedCall]);

  const callList = Object.values(calls).sort(
    (a, b) => new Date(b.startedAt) - new Date(a.startedAt)
  );

  const activeCall = selectedCall ? calls[selectedCall] : null;

  return (
    <div className="flex gap-6 h-[calc(100vh-80px)]">
      {/* Left panel — call list */}
      <div className="w-80 flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold">Active Calls</h2>
          <span className={`text-xs px-2 py-0.5 rounded-full ${connected ? "bg-green-900/30 text-green-400" : "bg-red-900/30 text-red-400"}`}>
            {connected ? "● Live" : "○ Disconnected"}
          </span>
        </div>

        {callList.length === 0 && (
          <div className="text-text-dim text-xs text-center py-12">
            No active calls.
            <br />
            Waiting for incoming calls…
          </div>
        )}

        <div className="space-y-2 overflow-y-auto flex-1">
          {callList.map((call) => (
            <button
              key={call.callUuid}
              onClick={() => setSelectedCall(call.callUuid)}
              className={`w-full text-left p-3 rounded-lg border transition-colors ${
                selectedCall === call.callUuid
                  ? "border-accent bg-accent/10"
                  : "border-border bg-surface hover:border-text-dim"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-text-muted">
                  {call.callerPhone}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    call.status === "active"
                      ? "bg-green-900/30 text-green-400"
                      : "bg-text-dim/20 text-text-dim"
                  }`}
                >
                  {call.status === "active" ? "LIVE" : call.outcome || "ended"}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-text-dim">
                {call.intent && (
                  <span className="bg-accent-4/10 text-accent-4 px-1.5 py-0.5 rounded">
                    {call.intent}
                  </span>
                )}
                <span>{call.turns} turn{call.turns !== 1 ? "s" : ""}</span>
                <span>
                  {formatDuration(call.startedAt, call.endedAt)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel — transcript */}
      <div className="flex-1 flex flex-col bg-surface border border-border rounded-lg overflow-hidden">
        {!activeCall ? (
          <div className="flex-1 flex items-center justify-center text-text-dim text-sm">
            Select a call to view live transcript
          </div>
        ) : (
          <>
            {/* Call header */}
            <div className="px-4 py-3 border-b border-border bg-surface2 flex items-center justify-between">
              <div>
                <span className="text-sm font-mono">{activeCall.callerPhone}</span>
                <span className="text-xs text-text-dim ml-3">
                  {activeCall.callUuid?.slice(0, 12)}…
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                {activeCall.intent && (
                  <span className="bg-accent-4/10 text-accent-4 px-2 py-0.5 rounded">
                    {activeCall.intent}
                  </span>
                )}
                {activeCall.lastLatency && (
                  <span className="text-text-dim">
                    {Math.round(activeCall.lastLatency)}ms
                  </span>
                )}
                <span
                  className={
                    activeCall.status === "active"
                      ? "text-green-400"
                      : "text-text-dim"
                  }
                >
                  {activeCall.status === "active"
                    ? `● Live — ${formatDuration(activeCall.startedAt)}`
                    : `Ended — ${formatDuration(activeCall.startedAt, activeCall.endedAt)}`}
                </span>
              </div>
            </div>

            {/* Transcript area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {activeCall.transcripts.map((t, i) => (
                <div
                  key={i}
                  className={`flex ${t.role === "user" ? "justify-start" : "justify-end"}`}
                >
                  <div
                    className={`max-w-[75%] px-3 py-2 rounded-lg text-sm ${
                      t.role === "user"
                        ? "bg-surface2 border border-border"
                        : "bg-accent/10 border border-accent/20"
                    }`}
                  >
                    <div className="text-[10px] text-text-dim mb-1">
                      {t.role === "user" ? "📞 Caller" : "🤖 AI"}
                      <span className="ml-2">
                        {new Date(t.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    {t.text}
                  </div>
                </div>
              ))}

              {/* Partial transcript (live preview) */}
              {activeCall.partial && (
                <div className="flex justify-start">
                  <div className="max-w-[75%] px-3 py-2 rounded-lg text-sm bg-surface2 border border-border border-dashed opacity-60">
                    <div className="text-[10px] text-text-dim mb-1">
                      📞 Caller (typing…)
                    </div>
                    {activeCall.partial}
                  </div>
                </div>
              )}

              <div ref={transcriptEndRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatDuration(startedAt, endedAt) {
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  const sec = Math.floor((end - start) / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}:${String(s).padStart(2, "0")}`;
}
