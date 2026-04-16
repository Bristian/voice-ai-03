# Car Dealership Voice AI

A real-time voice AI agent for inbound sales calls. When a sales rep doesn't pick up, Vonage forwards the call to an AI that can search vehicle inventory, answer FAQs, capture leads, and transfer to a human when needed.

**Status:** Slice 0 complete — shared contracts only. No runnable services yet.

## Monorepo Layout

```
car-dealership-voice-ai/
├── shared/                 # Cross-service contracts (slice 0)
│   ├── contracts/          # Canonical JSON schemas
│   ├── python/             # Pydantic v2 models for Python services
│   └── typescript/         # TS types + Zod schemas for Node/Next services
├── echokit-server/         # Node.js WebSocket audio orchestrator (slice 1+)
├── agent-api/              # Python FastAPI — LLM / RAG / SQL (slice 2+)
├── dashboard/              # Next.js supervisor UI (slice 5)
├── ingestion-worker/       # Python cron — doc embedding (slice 2+)
├── migrations/             # SQL migrations (slice 2+)
└── railway.toml            # Railway service declarations
```

## Documentation

- `architecture-overview.md` — system architecture
- `CLAUDE.md` — for Claude Code / AI-assisted editing
- `services-map.yaml` — machine-readable service registry
- `api-contracts.json` — REST + WebSocket contracts
- `sequence-diagrams.html` — visual sequence diagrams

## Build order (Option B — vertical slices)

| Slice | Goal | Services touched |
|---|---|---|
| 0 | Shared contracts | `shared/` |
| 1 | Hello-world call (Vonage → echo greeting) | `echokit-server` |
| 2 | RAG-only conversational turn | `agent-api`, `migrations`, PG, Redis |
| 3 | Voice-to-SQL vehicle search | `agent-api`, `vehicles` table |
| 4 | Barge-in + VAD tuning | `echokit-server` |
| 5 | Supervisor dashboard + WebRTC | `dashboard`, `echokit-server` |
| 6 | Hardening — recording, rate limits, observability | all |

Each slice is independently deployable to Railway.

## License

Proprietary — internal use only.
