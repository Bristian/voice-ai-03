# shared/

Canonical cross-service contracts. **This is the source of truth** for types that cross service boundaries.

## Layout

```
shared/
├── contracts/              # JSON Schema (Draft 2020-12) — canonical
│   ├── session.schema.json
│   ├── vehicle.schema.json
│   ├── agent-turn.schema.json
│   ├── webhook-events.schema.json
│   └── ws-events.schema.json
├── python/                 # Pydantic v2 — imported by agent-api, ingestion-worker
│   ├── pyproject.toml
│   └── src/voiceai_contracts/
│       ├── __init__.py
│       ├── session.py
│       ├── vehicle.py
│       ├── agent_turn.py
│       └── events.py
├── typescript/             # TS types + Zod — imported by echokit-server, dashboard
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── session.ts
│       ├── vehicle.ts
│       ├── agent-turn.ts
│       └── events.ts
└── scripts/
    └── verify-contracts.mjs   # Sanity check: all three representations match
```

## Why three representations?

The JSON Schemas are the canonical definition — they're machine-readable and language-neutral. The Python and TypeScript versions are hand-maintained to mirror them because:

1. Pydantic gives us runtime validation + FastAPI integration
2. Zod gives us the same for the Node services
3. Hand-rolled stays readable; auto-generated code is often hostile to diff review

When you change a contract:
1. Update the JSON Schema in `contracts/`
2. Update the Pydantic model in `python/src/voiceai_contracts/`
3. Update the TS + Zod in `typescript/src/`
4. Run `node shared/scripts/verify-contracts.mjs` to sanity-check alignment

## Installing

### Python services

```bash
# From agent-api/ or ingestion-worker/
pip install -e ../shared/python
```

Or in `requirements.txt`:
```
-e ../shared/python
```

### TypeScript services

```bash
# From echokit-server/ or dashboard/
npm install ../shared/typescript
```

Or in `package.json`:
```json
"dependencies": {
  "@voiceai/contracts": "file:../shared/typescript"
}
```

## Importing

```python
# Python
from voiceai_contracts import Session, Vehicle, AgentTurnRequest, AgentTurnResponse
```

```typescript
// TypeScript
import { Session, Vehicle, AgentTurnRequest, AgentTurnResponse, SessionSchema } from "@voiceai/contracts";
```
