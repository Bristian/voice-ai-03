# Slice 1 — Hello-World Call (Vonage + Railway)

**Goal:** place a real phone call to a real number and hear your own voice echoed back.

**What this proves:** the entire telephony path works — Vonage reaches our webhook, we return an NCCO, Vonage opens a WebSocket, audio streams both directions, Railway handles the deployment. Once this works, every later slice just swaps out parts of the pipeline (add STT here, add LLM there), without re-solving the plumbing.

**Time estimate:** 45–60 minutes, most of it waiting for Vonage trial verification.

**What you need:**
- A credit card for the Vonage trial (they won't charge it — it's for verification)
- A personal phone for the verification call
- A GitHub account
- A Railway account (signup via GitHub is easiest)

---

## Table of contents

1. [Overview — how the pieces fit](#1-overview)
2. [Upload the slice 1 code to GitHub](#2-upload-code)
3. [Deploy to Railway (first pass, without the URL)](#3-deploy-railway)
4. [Grab the Railway public domain](#4-railway-domain)
5. [Set `PUBLIC_URL` on Railway and redeploy](#5-set-public-url)
6. [Create the Vonage account](#6-vonage-account)
7. [Buy a trial phone number](#7-buy-number)
8. [Create the Vonage Voice Application](#8-voice-app)
9. [Link the number to the application](#9-link-number)
10. [Place the first test call](#10-test-call)
11. [Reading logs and debugging](#11-logs-debugging)
12. [Troubleshooting — the 8 things that usually go wrong](#12-troubleshooting)
13. [Concepts introduced in this slice](#13-concepts)
14. [What slice 2 will add](#14-next)

---

## 1. Overview

```
 ┌──────────┐         ┌──────────┐       ┌───────────────────┐       ┌─────────┐
 │  Your    │  calls  │          │  HTTPS│  echokit-server   │       │         │
 │ cell     │  ─────▶ │  Vonage  │ ─────▶│  on Railway       │       │         │
 │ phone    │         │  Voice   │◀───── │  /webhooks/answer │       │         │
 └──────────┘         │  API     │ NCCO  │                   │       │         │
       ▲              │          │       │                   │       │         │
       │              │          │  WSS  │                   │       │         │
       │              │          │ ─────▶│  /ws/voice        │       │         │
       │              │          │◀───── │                   │       │         │
       │              └──────────┘ audio │                   │       │         │
       │                                 └───────────────────┘       │         │
       │                                                              │         │
       └──────────── TTS greeting + echoed audio ─────────────────────┘         │
```

In plain words:

1. You dial your Vonage number from your cell phone.
2. Vonage sends an HTTPS POST to your Railway service's `/webhooks/answer` to ask "what should I do with this call?"
3. Your service returns an NCCO (Nexmo Call Control Object) that says: "speak this greeting, then open a WebSocket to my `/ws/voice` endpoint and stream the audio there."
4. Vonage speaks the greeting to you (a few seconds of Vonage's built-in TTS).
5. Vonage opens a persistent WebSocket to your service and starts streaming your voice as 640-byte audio frames, 50 frames per second.
6. Your service buffers the audio, detects when you stop talking, then writes the buffered audio back over the same WebSocket.
7. Vonage plays those bytes to you. You hear yourself.

---

## 2. Upload the slice 1 code to GitHub <a id="2-upload-code"></a>

You have two choices depending on whether you completed slice 0.

### 2a. If you already uploaded slice 0

The slice 1 zip contains the entire repo (slice 0 + slice 1). The simplest path is to **replace everything** in your existing repo.

1. In your local terminal:
   ```bash
   # From wherever you have the existing slice-0 folder (or skip to step 2 if you don't have it locally)
   cd ~/where-you-have-slice-0
   rm -rf * .[!.]*       # deletes every file AND hidden files (like .gitignore)
   ```
2. Unzip the slice 1 archive into that same folder.
3. Commit and push:
   ```bash
   git add -A
   git commit -m "slice 1: Vonage webhooks + WebSocket audio echo"
   git push
   ```

Or via the GitHub web UI: in your repo, click any file → **Delete file** → repeat for everything (tedious but doable), then drag-drop the new zip contents in.

### 2b. Fresh start

If you're starting from scratch (didn't do slice 0 before or want a clean repo):

1. Go to https://github.com/new
2. Name: `car-dealership-voice-ai`, **Private**, no README/gitignore/license
3. Click **Create repository**
4. Unzip `car-dealership-voice-ai-slice-1.zip` locally
5. Drag-drop its contents into the "upload an existing file" page (or use `git`):
   ```bash
   cd car-dealership-voice-ai-slice-1
   git init
   git add .
   git commit -m "slices 0 + 1: contracts and Vonage hello-world"
   git branch -M main
   git remote add origin https://github.com/YOUR_USER/car-dealership-voice-ai.git
   git push -u origin main
   ```

### What to confirm before moving on

Look at your repo on GitHub. You should see:

- `README.md`
- `SLICE-0-SETUP.md`, `SLICE-1-SETUP.md`
- `package.json` (root — declares npm workspaces)
- `nixpacks.toml`, `railway.toml`
- `shared/` folder (from slice 0)
- `echokit-server/` folder with `src/server.js`, `src/websocket.js`, etc.

---

## 3. Deploy to Railway (first pass) <a id="3-deploy-railway"></a>

We'll deploy first, then wire Vonage to the resulting URL. Doing it in this order means we know the Railway URL before we fill in Vonage's webhook fields.

### 3a. Sign up / sign in

Go to https://railway.app. Sign in with GitHub (simplest). Free trial gives you about $5/month of usage — plenty for this service.

### 3b. Create a new project from your repo

1. From the Railway dashboard, click **New Project**
2. Choose **Deploy from GitHub repo**
3. If this is your first time, Railway will ask to install its GitHub app. Grant access — you can limit it to just the `car-dealership-voice-ai` repo.
4. Select `car-dealership-voice-ai` from the list
5. You'll see **"Railway detected a JavaScript monorepo"** and it will propose one service per workspace package. **Uncheck `@voiceai/contracts`** — that's a library, not a deployable service. Keep only `echokit-server`.
6. Click **Deploy**

### 3c. Watch the build

You'll land on the project canvas. Click the `echokit-server` service tile. The **Deployments** tab shows build logs streaming live.

The build should:

1. Detect Nixpacks, pull Node.js 20
2. Run `npm install --workspaces --include-workspace-root`
3. Run `cd /app/shared/typescript && npm run build`
4. Start with `node echokit-server/src/server.js`

**This first deploy will fail** — that's expected. The server exits immediately because `PUBLIC_URL` isn't set. You'll see an error like:

```
Invalid environment configuration:
  • PUBLIC_URL: PUBLIC_URL must start with https:// (Vonage requires TLS)
```

That's good. It means the service built, started, and validated its config. We just need to give it the URL.

---

## 4. Grab the Railway public domain <a id="4-railway-domain"></a>

Railway doesn't give services a public URL by default — you have to generate one.

1. In the `echokit-server` service, click the **Settings** tab
2. Scroll down to **Networking**
3. Under **Public Networking**, click **Generate Domain**
4. Railway creates something like `echokit-server-production-abc1.up.railway.app`
5. **Copy this URL.** You'll paste it into two places: Railway's env vars and (later) Vonage's dashboard.

> 💡 Keep this URL handy. I'll refer to it as `RAILWAY_URL` from here on.

---

## 5. Set `PUBLIC_URL` and redeploy <a id="5-set-public-url"></a>

1. In the `echokit-server` service, click the **Variables** tab
2. Click **+ New Variable**
3. Add:

   | Name | Value |
   |---|---|
   | `PUBLIC_URL` | `https://<RAILWAY_URL>` (full `https://` prefix, **no trailing slash**) |
   | `NODE_ENV` | `production` |
   | `LOG_LEVEL` | `info` |

4. Leave `VONAGE_SIGNATURE_SECRET` unset for now. We'll enable signing later.

5. Railway auto-redeploys when variables change. Watch the **Deployments** tab.

### Verify the service is alive

In a browser, visit `https://<RAILWAY_URL>/healthz`. You should see:

```json
{
  "status": "ok",
  "service": "echokit-server",
  "env": "production",
  "uptime_s": 12,
  "signature_verification": "disabled"
}
```

Also visit `https://<RAILWAY_URL>/` and you'll see a plain-text list of endpoints.

If both show up — great, the service is live on the public internet. Move on.

If you get an error, jump to [Troubleshooting](#12-troubleshooting).

---

## 6. Create the Vonage account <a id="6-vonage-account"></a>

Vonage used to be called Nexmo. You'll see both names in their docs and dashboard — they're the same thing.

1. Go to https://developer.vonage.com
2. Click **Sign up** (top right)
3. Fill in the form. You can use a throwaway email for testing.
4. **Verify your personal phone number.** Vonage calls or texts a code. This is for fraud prevention — required even for free trials.
5. Log into https://dashboard.nexmo.com (that's the dashboard, yes, still the old "nexmo" hostname)

### Grab your API key and secret

You'll see them at the top of the dashboard. Format:

- **API key**: something like `abc12345`
- **API secret**: a longer alphanumeric string

**Save both in a password manager.** You don't need them for slice 1 (Vonage Voice API uses JWT authentication via the application's private key, not the key/secret), but later slices will.

### Add trial credit (optional but recommended)

Vonage gives new accounts around €2 in credit — enough for dozens of test calls. If you want more:

1. Dashboard → **Billing** → **Add payment method**
2. Add $5 or $10. Each inbound call costs fractions of a cent.

---

## 7. Buy a trial phone number <a id="7-buy-number"></a>

1. Dashboard → **Numbers** (left sidebar) → **Buy numbers**
2. Pick a country. **For slice 1, choose a country close to you** so call quality is good. US numbers are usually cheapest.
3. **Features required:** `Voice` — must be checked. `SMS` is optional.
4. **Type:** `Mobile` or `Landline` both work. Mobile is fine.
5. Click **Search**
6. Pick any number you like and click **Buy**

**Cost:** roughly $1/month for US numbers, more for others. For a trial, the first number is often free or paid from your trial credit.

**You now own a phone number.** Write it down in E.164 format (`+15551234567`).

---

## 8. Create the Vonage Voice Application <a id="8-voice-app"></a>

A Vonage "Application" is a configuration object that says:
- "Here are the webhook URLs to call for inbound calls on my number"
- "Here's the public key I'll use to verify you"
- "I want voice capability enabled"

You can think of it as the glue between your phone number and your Railway service.

### 8a. Create it

1. Dashboard → **Applications** (left sidebar) → **+ Create a new application**
2. **Name:** `car-dealership-voice-ai` (any name works; this is just for your reference)
3. Click **Generate public and private key**
   - A `private.key` file downloads to your computer
   - **You don't need this file for slice 1.** (The Voice API needs it only for *outbound* calls; inbound calls don't require signing.)
   - **Keep it anyway.** Save it somewhere safe — later slices will use it. **Do not commit it to git.**
4. Scroll down to **Capabilities**
5. Toggle **Voice** ON

### 8b. Fill in the webhook URLs

With Voice enabled, you'll see fields for:

| Field | Value |
|---|---|
| **Answer URL** | `https://<RAILWAY_URL>/webhooks/answer` — method: `POST` |
| **Event URL** | `https://<RAILWAY_URL>/webhooks/events` — method: `POST` |
| **Fallback URL** | `https://<RAILWAY_URL>/webhooks/fallback` — method: `POST` |

> ⚠️ **Trailing slashes matter.** Do not add trailing slashes. `/webhooks/answer` not `/webhooks/answer/`.

> ⚠️ **Choose `POST` for each.** The default is sometimes `GET`; our server handles both but POST is the stable contract.

### 8c. Save

Click **Generate new application** (or **Save** if you're editing an existing one).

You'll land on the application detail page. Note the **Application ID** (long UUID). Save it somewhere — later slices need it for outbound calls.

---

## 9. Link the number to the application <a id="9-link-number"></a>

Right now, your Voice Application exists but has no phone numbers attached. Calls to your number won't trigger anything yet.

1. On the Application detail page, scroll to the **Linked numbers** section
2. Find your trial number in the list
3. Click **Link**

The row should now show **Linked** with a green check (or similar). Done.

### Double-check from the other direction

As a sanity check: Dashboard → **Numbers** → **Your numbers**. Your number should show the application name you chose above.

---

## 10. Place the first test call <a id="10-test-call"></a>

Before you dial, **open the Railway logs in a separate browser tab** so you can watch events arrive in real time:

1. Railway dashboard → your project → `echokit-server` service → **Deployments** tab → click the active deployment → **View Logs**

Now:

1. On your cell phone, dial your Vonage number (exactly as Vonage shows it, with country code)
2. Wait 2–3 seconds. You should hear Vonage's TTS say the greeting: *"Hello, thanks for calling. This is a test of the voice AI system. After the beep, anything you say will be echoed back to you. Go ahead."*
3. **Speak a short sentence.** Something like: *"One two three, testing the echo."*
4. Stop talking. Wait about 1 second.
5. You'll hear your own voice played back.

If that works — **congratulations. Slice 1 is done.** You've proven the entire telephony and audio pipeline works end-to-end.

### What you should see in the Railway logs

As you place the call, watch the log stream fill in roughly this order:

```
INFO  Answer webhook received
      from: "+1XXXYYYZZZZ"
      to: "+1AAAAAAAAAA"
      conversation_uuid: "CON-..."
INFO  Call event: ringing
INFO  Call event: answered
INFO  Vonage WebSocket connected
      conn_id: "conn-xxxxx"
INFO  WS text frame: websocket:connected
INFO  Call audio stream established
      call_uuid: "..."
      from: "+1..."
      to: "+1..."
      contentType: "audio/l16;rate=16000"
INFO  Speech start detected
      rms: 4200
INFO  End of utterance — starting replay
      capturedFrames: 152
      capturedMs: 3040
INFO  Replay #1 starting
INFO  Replay complete — listening again
INFO  Call WebSocket closed
      code: 1005
      framesReceived: 250
      framesSent: 152
      replays: 1
INFO  Call event: completed
```

If the log pattern matches, every piece worked. Try speaking again — you can do multiple echo rounds within one call.

---

## 11. Reading logs and debugging <a id="11-logs-debugging"></a>

You'll live in the logs as you build later slices, so it's worth getting comfortable now.

### Railway log UI

- **Deployments** tab → click the running deployment → **View Logs**
- Logs stream live; there's also a search box
- Filter by selecting a time range from the top
- Each log line is one JSON object on the server side; Railway's UI pretty-prints them

### Common fields you'll filter on

- `call_uuid` — groups all log lines for a single call
- `level` (`info`, `warn`, `error`) — filter to `warn` and above to skip routine traffic
- `conn_id` — a WebSocket connection's internal ID, useful when `call_uuid` isn't known yet (the first few milliseconds)

### Useful ad-hoc tests

- Browser → `https://<RAILWAY_URL>/healthz` — should return `{"status":"ok",...}`
- Browser → `https://<RAILWAY_URL>/` — shows the endpoint list
- From terminal:
  ```bash
  curl -X POST https://<RAILWAY_URL>/webhooks/answer \
    -H 'Content-Type: application/json' \
    -d '{"uuid":"test-abc","from":"+15551234567","to":"+15559999999"}'
  ```
  Should return a JSON NCCO array. This is exactly what Vonage will do.

### Vonage's own logs

Dashboard → **Logs** (left sidebar, scroll down). Shows every call Vonage handled, including any errors *on their side* (e.g., your answer webhook returned a 500, or the NCCO was malformed).

---

## 12. Troubleshooting <a id="12-troubleshooting"></a>

### 12a. "I hear nothing — not even the greeting"

**Most likely:** Vonage couldn't reach your answer webhook, or your webhook returned something that isn't a valid NCCO.

1. Check Vonage **Logs** page. Look for your recent call. If the status is `failed` with an error mentioning `answer_url`, that's the giveaway.
2. Check that your **Answer URL** in the Voice Application is `https://<RAILWAY_URL>/webhooks/answer` — full URL, starts with `https://`, no typos.
3. Open the Railway logs during another call attempt. If no `Answer webhook received` line appears, Vonage isn't reaching you.
4. Test your webhook directly with curl (see §11). If curl works and Vonage doesn't, it's a Vonage config problem, not a code problem.

### 12b. "I hear the greeting but no echo"

**Most likely:** the WebSocket didn't connect, or audio isn't flowing back.

1. In the Railway logs, look for `Vonage WebSocket connected`. If missing, Vonage never opened the WS — probably the `wss://` URL in the NCCO is wrong.
2. Confirm `PUBLIC_URL` is set correctly on Railway. Visit `/healthz` — if the URL doesn't start with `https://` or has a typo, the derived `wss://` URL will be wrong.
3. Look for `Speech start detected` after you spoke. If missing, the RMS threshold (800) is higher than your call's audio level — try speaking louder, or lowering the threshold in `src/websocket.js`.

### 12c. "I hear the greeting, then total silence"

**Most likely:** WebSocket opened but audio frames aren't flowing either direction.

1. Check the logs for `Received 1s of audio` (happens every second during an active call). If missing, Vonage isn't sending us audio — rare; usually a Vonage regional routing issue.
2. If you see `Unexpected binary frame size` warnings, the `content-type` in the NCCO is wrong — it must be exactly `audio/l16;rate=16000`.

### 12d. "Build fails on Railway"

1. Click the failing deployment → **View Logs**
2. Scroll to the top of the build log (not the end — errors are rarely at the bottom)
3. Common causes:
   - **`PUBLIC_URL: Required`** — you haven't set the env var yet. See [§5](#5-set-public-url).
   - **`EUNSUPPORTEDPROTOCOL`, workspace errors** — you probably set a Root Directory in the service settings. Leave it at `/`. Our `nixpacks.toml` at the root handles everything.
   - **`Cannot find module '@voiceai/contracts'`** — the contracts workspace didn't build. Check `shared/typescript/package.json` exists in the commit.

### 12e. "Deployment succeeds but /healthz returns 404"

You're hitting an old cached deployment. Force a fresh redeploy:

- Railway → `echokit-server` → three-dot menu → **Redeploy**

### 12f. "Call drops immediately after the greeting"

Vonage is closing the call because our server rejected the WebSocket upgrade.

1. Railway logs — look for `Rejecting WS upgrade for unknown path` warnings. If the path isn't `/ws/voice`, the NCCO's URI is wrong.
2. Verify `PUBLIC_URL` is exactly your Railway domain with `https://` and nothing else.

### 12g. "I called but Vonage says 'number not in service'"

Either you haven't linked the number to the application, or your trial credit is exhausted.

1. Dashboard → **Numbers** → **Your numbers** → confirm the number shows your application name
2. Dashboard top bar → check your credit balance

### 12h. "Echo works but sounds distorted / chipmunk / slowed down"

Audio format mismatch. Either Vonage is sending a different format than expected, or we're sending back the wrong format.

1. Confirm the NCCO's `content-type` is exactly `audio/l16;rate=16000` (check server logs — it's echoed at "Call audio stream established")
2. Confirm your outbound frames are 640 bytes and 50 frames/second — the `Replay complete` log should show `sent` = roughly 50 × seconds spoken. If it's 25 or 100, our code has an issue.

---

## 13. Concepts introduced in this slice <a id="13-concepts"></a>

### Vonage (formerly Nexmo)

A telephony-as-API company. They own phone numbers in dozens of countries and expose a REST API (and webhooks) for making/receiving calls. Their Voice API lets us handle calls entirely with code — no PBX, no hardware.

### NCCO (Nexmo Call Control Object)

A JSON array of actions telling Vonage what to do with a call. Common actions: `talk` (speak text via built-in TTS), `connect` (bridge to another endpoint — phone, SIP, or WebSocket), `record`, `input` (collect DTMF or speech). Our `/webhooks/answer` returns one of these.

### WebSocket (WSS)

A long-lived TCP connection that stays open and lets both sides send messages whenever. We use it for streaming audio because HTTP-per-frame would have unmanageable overhead (50 requests/second, each opening a new connection).

### Linear PCM / `audio/l16;rate=16000`

Uncompressed 16-bit signed integer audio samples. "L16" = Linear, 16-bit. "rate=16000" = 16,000 samples per second. "Mono" = one channel. Each 20ms frame is 16000 × 0.02 × 2 = **640 bytes**. This is the format Vonage uses on WebSockets — same in both directions.

### Railway

A hosting platform similar to Heroku/Vercel but WebSocket-friendly out of the box. Every push to GitHub triggers an auto-rebuild. One-click plugins for managed PostgreSQL and Redis (we'll use those in slice 2).

### Nixpacks

Railway's build system. Reads your code, figures out "this is Node.js" or "this is Python", installs dependencies, and produces a container image. Our `nixpacks.toml` at the repo root overrides the auto-detection to handle our workspace layout.

### RMS-based voice activity detection

A cheap way to detect speech: compute the root-mean-square of each 20ms audio frame's samples. If it's above a threshold (we use 800 on a 16-bit scale), it's probably speech. If not, silence. Real systems use neural models (Silero VAD) for better accuracy; we'll swap ours for Silero in slice 4.

### Graceful shutdown (SIGTERM)

When Railway redeploys your service, it sends a `SIGTERM` signal and waits ~30 seconds for you to close connections cleanly. Our `server.js` handles this — it stops accepting new connections, closes active WebSockets with status 1001 ("going away"), and then exits. Without this, mid-call redeploys would drop callers abruptly.

---

## 14. What slice 2 will add <a id="14-next"></a>

Slice 1 gets a call in and pipes audio through. Slice 2 replaces the echo logic with an actual conversational agent:

- `agent-api/` — new Python FastAPI service
- PostgreSQL + Redis (Railway plugins, 1-click)
- pgvector extension for semantic search over a small FAQ knowledge base
- OpenAI integration (embeddings + GPT-4o)
- ElevenLabs streaming STT
- OpenAI streaming TTS
- The `echokit-server` gets a new code path: instead of echoing audio, it streams it to STT, gets a transcript, posts it to `agent-api`, receives a response, synthesizes it with TTS, and streams the PCM back

That's a big slice. We'll split it into 2a (database + RAG without audio, verified with curl) and 2b (wire the audio pipeline back into it).

For slice 2 you'll need:
- An OpenAI API key (~$5 of credit is plenty for testing)
- An ElevenLabs API key (free tier works for development)

---

## How to know slice 1 is "done" and ready for slice 2

You can tick all of these:

- [ ] Code is pushed to your GitHub repo's `main` branch
- [ ] `echokit-server` is deployed on Railway and shows status "Active"
- [ ] Visiting `https://<RAILWAY_URL>/healthz` returns `{"status":"ok",...}`
- [ ] Your Vonage Voice Application has Answer/Event/Fallback URLs pointing at your Railway domain
- [ ] Your phone number is linked to the application
- [ ] Calling your Vonage number from your cell:
  - You hear the TTS greeting
  - You speak and hear yourself echoed back
  - The Railway logs show the full call lifecycle (answer → WS connected → speech detected → replay → close)

Reply **"slice 2"** when you're ready to build the RAG-powered agent.
