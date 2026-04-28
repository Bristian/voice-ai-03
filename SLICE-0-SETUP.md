# Slice 0 — Shared Contracts Package

**Goal:** establish a canonical source of truth for every type that crosses a service boundary, before any service exists.

**Status after this slice:** nothing deploys yet. No Railway. No Vonage. No database. This is code-only, designed to be imported by future services.

**Why bother with this first?** Every subsequent slice will either produce or consume one of these types. Having them defined upfront means when `echokit-server` sends an `AgentTurnRequest` to `agent-api` in slice 2, both sides know exactly what the shape looks like — not because you wrote a design doc, but because they both import from the same package.

---

## What's in this slice

```
shared/
├── README.md                  # how to use the package
├── contracts/                 # JSON Schema 2020-12 — canonical
│   ├── session.schema.json
│   ├── vehicle.schema.json
│   ├── agent-turn.schema.json
│   ├── webhook-events.schema.json
│   └── ws-events.schema.json
├── python/                    # Pydantic v2 package
│   ├── pyproject.toml
│   └── src/voiceai_contracts/
│       ├── __init__.py
│       ├── session.py
│       ├── vehicle.py
│       ├── agent_turn.py
│       ├── events.py
│       └── py.typed
├── typescript/                # TypeScript + Zod package
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── session.ts
│       ├── vehicle.ts
│       ├── agent-turn.ts
│       └── events.ts
└── scripts/
    └── verify-contracts.mjs   # drift checker
```

Plus at the repo root: `README.md`, `.gitignore`, `railway.toml` (placeholder).

---

## Step 1 — Create the GitHub repo

1. Go to **https://github.com/new**
2. Name: `car-dealership-voice-ai` (or whatever you prefer)
3. **Private** is recommended while building
4. Do **NOT** check "Add a README" / "Add .gitignore" / "Add license" — the upload already contains those
5. Click **Create repository**

GitHub now shows a page with setup instructions. Leave it open.

---

## Step 2 — Upload the slice 0 code

### Option A: drag-and-drop (easiest, no git experience needed)

1. Unzip the slice 0 archive you received (`car-dealership-voice-ai-slice-0.zip`)
2. On the GitHub page showing setup instructions, click the link **"uploading an existing file"**
3. Drag every file and folder from the unzipped directory into the browser window
4. Scroll down, enter commit message: `slice 0: shared contracts`
5. Click **Commit changes**

### Option B: git CLI (cleaner history)

```bash
cd ~/Downloads
unzip car-dealership-voice-ai-slice-0.zip
cd car-dealership-voice-ai-slice-0

git init
git add .
git commit -m "slice 0: shared contracts"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/car-dealership-voice-ai.git
git push -u origin main
```

---

## Step 3 — Verify the package locally (optional but recommended)

This catches any issue before you build services on top of it. If you don't have Node.js and Python locally, skip this step — the code is already validated.

### 3a. Python — Pydantic v2 models

```bash
# From the repo root:
python3 -m pip install pydantic>=2.6
pip install -e shared/python

# Quick sanity check:
python3 -c "from voiceai_contracts import Session, Vehicle, AgentTurnRequest; print('OK')"
```

Expected output: `OK`

### 3b. TypeScript — types + Zod schemas

```bash
# From the repo root:
cd shared/typescript
npm install
npm run build
cd ../..
```

Expected: no errors, a `dist/` folder appears under `shared/typescript/`.

### 3c. Run the drift checker

```bash
node shared/scripts/verify-contracts.mjs
```

Expected output:
```
✓ loaded 5 JSON Schema file(s)
✓ 25 Python exports detected
✓ 65 TypeScript exports detected
✓ All canonical names appear in both Python and TypeScript exports.
✓ Contracts look aligned.
```

---

## Step 4 — What about Railway?

**Skip it.** Slice 0 has no services to deploy.

In slice 1 we will:
1. Create a Railway project from your GitHub repo
2. Configure the first service (`echokit-server`)
3. Walk through environment variables, domain setup, and log viewing

Adding services to Railway is a 2-minute operation per service; doing it here with nothing to run would be wasted effort.

---

## How to know slice 0 is "done" and ready for slice 1

You can tick all of these:

- [ ] The GitHub repo exists with the slice 0 files committed to `main`
- [ ] You can see the folder structure matches what's shown above
- [ ] (Optional) `pip install -e shared/python` works locally without errors
- [ ] (Optional) `npm install && npm run build` works under `shared/typescript/` without errors
- [ ] (Optional) `node shared/scripts/verify-contracts.mjs` prints all green

---

## Concepts introduced in this slice — brief primer

You said you're unfamiliar with several systems. Slice 0 doesn't touch any of them yet, but it's worth understanding what's coming:

### JSON Schema
An industry-standard way to describe the shape of JSON data. Our `*.schema.json` files define exactly what fields each type has, what they're called, what types they are, and what's required. They're the *language-neutral* contract — Python and TypeScript mirror them.

### Pydantic
A Python library that turns class definitions into runtime validators. When `agent-api` receives an HTTP request, Pydantic checks the body matches `AgentTurnRequest` and rejects it if not. We're using v2 (the current version).

### Zod
The TypeScript equivalent of Pydantic. When `echokit-server` receives a Vonage webhook, Zod checks the body matches `AnswerWebhookRequest` and rejects it if not. Same idea, different language.

### Systems you'll meet in later slices

| System | Slice | What it is |
|---|---|---|
| **Vonage** | 1 | Phone-call API. They give you a phone number and call your server with webhooks when calls come in. |
| **Railway** | 1 | Deployment platform. Like Vercel/Heroku but WebSocket-friendly, with 1-click PostgreSQL and Redis. |
| **Node.js + WebSockets** | 1 | JavaScript runtime. WebSockets are long-lived bidirectional connections — Vonage uses them to stream audio. |
| **"EchoKit server"** | 1 | Just a name for our own Node.js service that orchestrates the audio pipeline. Not a third-party tool. |
| **PostgreSQL** | 2 | The industry-default relational database. Railway provisions one with one click. |
| **pgvector** | 2 | A PostgreSQL extension that adds a `vector` column type for semantic search. Enables "find similar" queries. |
| **Redis** | 2 | An in-memory key-value store. We use it for session state, caching TTS audio, and rate limiting. Sub-millisecond. |
| **ElevenLabs** | 4 | Voice AI company. We use their streaming speech-to-text. |
| **OpenAI** | 2 | LLMs (GPT-4o) + text-to-speech + embeddings. |
| **Cloudflare R2** | 6 | Object storage, S3-compatible but cheaper. We'll store call recordings there for compliance. |

---

## What slice 1 will contain

- The `echokit-server/` folder — a Node.js service
- Three Vonage webhook endpoints (`/webhooks/answer`, `/webhooks/events`, `/webhooks/fallback`)
- HMAC signature validation for those webhooks
- A minimal WebSocket handler at `/ws/voice` that accepts Vonage's audio stream
- A hardcoded "hello, thanks for calling the dealership" greeting played back to the caller (no AI, no STT, no LLM — just audio playback)
- Structured JSON logging
- A `/healthz` endpoint for Railway's health checks
- **Full walkthrough:** creating a Vonage account, buying a trial number, creating a Vonage Voice Application, setting the webhook URLs to your Railway domain, and placing your first test call

After slice 1 you'll be able to dial your Vonage number and hear the AI say hello. That's the end-to-end proof the telephony layer works, which is the foundation for everything else.

---

## Questions before we move on?

Common ones:

> **Do I need to understand all the JSON schemas?**
> No. They're for future services to import. You don't interact with them directly.

> **Can I skip slice 0 and go straight to slice 1?**
> You could, but slice 1 doesn't actually use any of the shared contracts yet — the hello-world call is too simple. Slice 2 is where they start mattering. Keeping slice 0 separate means when we do hit slice 2, all the groundwork is already in GitHub.

> **What if the verification script fails after I make edits later?**
> It means you changed one representation (say, a JSON schema) without updating the other two. The error message tells you which one is missing what.

When you've confirmed the code is in GitHub, reply "slice 1" and I'll build the Vonage hello-world service.
