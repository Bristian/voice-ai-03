# Car Dealership Voice AI

A real-time voice AI agent for inbound sales calls. When a sales rep doesn't pick up, Vonage forwards the call to an AI that can search vehicle inventory, answer FAQs, capture leads, and transfer to a human when needed.

**Status:** Slice 2a complete — AI agent backend with RAG + Voice-to-SQL, verifiable via curl. Slice 1's echo service still runs alongside.

## Monorepo Layout

```
car-dealership-voice-ai/
├── shared/                 # ✅ Slice 0 — cross-service contracts
├── echokit-server/         # ✅ Slice 1 — WebSocket audio orchestrator (Node.js)
├── agent-api/              # ✅ Slice 2a — Python FastAPI (LLM / RAG / SQL)
├── dashboard/              # Slice 5 — Next.js supervisor UI
├── ingestion-worker/       # Slice 2+ — Python cron (doc embedding)
├── migrations/             # ✅ Slice 2a — SQL schema + seed data
└── railway.toml            # Railway service declarations
```

## Documentation

- `SLICE-0-SETUP.md` — setting up the repo and shared contracts
- `SLICE-1-SETUP.md` — Vonage account, Railway deploy, first test call
- `architecture-overview.md` — system architecture
- `CLAUDE.md` — for Claude Code / AI-assisted editing

## Build order (Option B — vertical slices)

| Slice | Goal | Services touched | Status |
|---|---|---|---|
| 0 | Shared contracts | `shared/` | ✅ |
| 1 | Hello-world call (Vonage → echo) | `echokit-server` | ✅ |
| 2 | RAG-only conversational turn | `agent-api`, `migrations`, PG, Redis | ✅ (2a) |
| 3 | Voice-to-SQL vehicle search | `agent-api`, `vehicles` table | — |
| 4 | Barge-in + VAD tuning | `echokit-server` | — |
| 5 | Supervisor dashboard + WebRTC | `dashboard`, `echokit-server` | — |
| 6 | Hardening — recording, rate limits, observability | all | — |

## License

Proprietary — internal use only.
